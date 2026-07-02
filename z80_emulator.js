// SM83 (a.k.a. "GB-Z80"/LR35902) CPU core, written for GBS (Game Boy Sound) playback:
// GBS files contain SM83 machine code for the original DMG music driver. This is NOT a
// standard Zilog Z80 — the Game Boy's CPU is a cut-down variant that drops IX/IY, the
// shadow register set (EXX/EX AF,AF'), block instructions (LDIR/CPIR/etc.), and the whole
// ED-prefixed extended set, while repurposing several of those opcode slots for GB-specific
// instructions (LD (HL+),A, LDH (n),A, ADD SP,e, ...) that real driver code relies on
// constantly (LDH in particular is how driver code hits the sound registers, which live in
// the 0xFF00 page). It also uses a different flag-register bit layout than Z80: only
// Z/N/H/C exist, at bits 7/6/5/4 — no sign flag, no parity/overflow flag, no undocumented
// X/Y bits. Structured like Arm7Cpu/GbaMemoryBus in gsf_emulator.js (register file, bus
// abstraction, cycle counting, step()/_stepFast() dispatch) but implements a different ISA,
// so no code is shared between the two cores.
//
// Bus contract: bus.read8(addr)/bus.write8(addr,value) for the 16-bit memory space. GB has
// no separate I/O address space (everything is memory-mapped in the 0xFF00 page), so unlike
// a real Z80 there's no ioIn/ioOut here.
(function () {
  const FLAG_C = 0x10, FLAG_H = 0x20, FLAG_N = 0x40, FLAG_Z = 0x80;

  function u8(v) { return v & 0xff; }
  function u16(v) { return v & 0xffff; }
  function signed8(v) { return (v & 0x80) ? (v - 256) : v; }

  class Sm83Cpu {
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.a = 0; this.f = 0; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
      this.sp = 0xfffe; this.pc = 0;
      this.ime = false;
      this.halted = false;
      this.stopped = false;
      this.illegal = false;
      this.cycles = 0;
      this.instructions = 0;
    }

    get bc() { return (this.b << 8) | this.c; }
    set bc(v) { this.b = (v >>> 8) & 0xff; this.c = v & 0xff; }
    get de() { return (this.d << 8) | this.e; }
    set de(v) { this.d = (v >>> 8) & 0xff; this.e = v & 0xff; }
    get hl() { return (this.h << 8) | this.l; }
    set hl(v) { this.h = (v >>> 8) & 0xff; this.l = v & 0xff; }
    get af() { return (this.a << 8) | (this.f & 0xf0); }
    set af(v) { this.a = (v >>> 8) & 0xff; this.f = v & 0xf0; }

    _rd(addr) { return this.bus.read8(addr & 0xffff); }
    _wr(addr, v) { this.bus.write8(addr & 0xffff, v & 0xff); }

    _fetch8() {
      const v = this._rd(this.pc);
      this.pc = u16(this.pc + 1);
      return v;
    }
    _fetch16() {
      const lo = this._fetch8();
      const hi = this._fetch8();
      return (hi << 8) | lo;
    }
    _push16(v) {
      this.sp = u16(this.sp - 1);
      this._wr(this.sp, (v >>> 8) & 0xff);
      this.sp = u16(this.sp - 1);
      this._wr(this.sp, v & 0xff);
    }
    _pop16() {
      const lo = this._rd(this.sp);
      this.sp = u16(this.sp + 1);
      const hi = this._rd(this.sp);
      this.sp = u16(this.sp + 1);
      return (hi << 8) | lo;
    }

    // 8-bit register-by-index (r index 0-7: B,C,D,E,H,L,(HL),A) — no IX/IY variant exists.
    _readR(idx) {
      switch (idx) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return this.h;
        case 5: return this.l;
        case 6: return this._rd(this.hl);
        case 7: return this.a;
      }
    }
    _writeR(idx, val) {
      val &= 0xff;
      switch (idx) {
        case 0: this.b = val; break;
        case 1: this.c = val; break;
        case 2: this.d = val; break;
        case 3: this.e = val; break;
        case 4: this.h = val; break;
        case 5: this.l = val; break;
        case 6: this._wr(this.hl, val); break;
        case 7: this.a = val; break;
      }
    }
    // 16-bit register-pair-by-index (rp index 0-3: BC,DE,HL,SP)
    _readRp(idx) {
      switch (idx) { case 0: return this.bc; case 1: return this.de; case 2: return this.hl; case 3: return this.sp; }
    }
    _writeRp(idx, val) {
      val = u16(val);
      switch (idx) { case 0: this.bc = val; return; case 1: this.de = val; return; case 2: this.hl = val; return; case 3: this.sp = val; return; }
    }
    // rp2 index 0-3 for PUSH/POP: BC,DE,HL,AF
    _readRp2(idx) { return idx === 3 ? this.af : this._readRp(idx); }
    _writeRp2(idx, val) { if (idx === 3) this.af = val; else this._writeRp(idx, val); }

    // Only 4 real conditions exist on GB (NZ,Z,NC,C); the PO/PE/P/M slots don't exist and
    // are repurposed for other instructions at the call sites that would otherwise use them.
    _checkCond(cc) {
      switch (cc) {
        case 0: return !(this.f & FLAG_Z);
        case 1: return !!(this.f & FLAG_Z);
        case 2: return !(this.f & FLAG_C);
        case 3: return !!(this.f & FLAG_C);
      }
    }

    // --- 8-bit ALU (op 0-7: ADD,ADC,SUB,SBC,AND,XOR,OR,CP) ---
    _alu(op, val) {
      switch (op) {
        case 0: this._add8(val, 0); break;
        case 1: this._add8(val, this.f & FLAG_C ? 1 : 0); break;
        case 2: this._sub8(val, 0); break;
        case 3: this._sub8(val, this.f & FLAG_C ? 1 : 0); break;
        case 4: this._logic8(this.a & val, true); break;
        case 5: this._logic8(this.a ^ val, false); break;
        case 6: this._logic8(this.a | val, false); break;
        case 7: this._cp8(val); break;
      }
    }
    _add8(val, carryIn) {
      const a = this.a;
      const sum = a + val + carryIn;
      const result = sum & 0xff;
      let f = 0;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) + (val & 0xf) + carryIn) & 0x10) f |= FLAG_H;
      if (sum > 0xff) f |= FLAG_C;
      this.a = result;
      this.f = f;
    }
    _sub8(val, carryIn) {
      const a = this.a;
      const diff = a - val - carryIn;
      const result = diff & 0xff;
      let f = FLAG_N;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) - (val & 0xf) - carryIn) & 0x10) f |= FLAG_H;
      if (diff < 0) f |= FLAG_C;
      this.a = result;
      this.f = f;
    }
    _cp8(val) {
      const a = this.a;
      const diff = a - val;
      const result = diff & 0xff;
      let f = FLAG_N;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) - (val & 0xf)) & 0x10) f |= FLAG_H;
      if (diff < 0) f |= FLAG_C;
      this.f = f;
    }
    _logic8(result, isAnd) {
      result &= 0xff;
      let f = isAnd ? FLAG_H : 0;
      if (result === 0) f |= FLAG_Z;
      this.a = result;
      this.f = f;
    }
    _inc8(val) {
      const result = (val + 1) & 0xff;
      let f = this.f & FLAG_C;
      if (result === 0) f |= FLAG_Z;
      if ((val & 0xf) === 0xf) f |= FLAG_H;
      this.f = f;
      return result;
    }
    _dec8(val) {
      const result = (val - 1) & 0xff;
      let f = (this.f & FLAG_C) | FLAG_N;
      if (result === 0) f |= FLAG_Z;
      if ((val & 0xf) === 0) f |= FLAG_H;
      this.f = f;
      return result;
    }
    _add16(a, b) {
      const result = (a + b) & 0xffff;
      let f = this.f & FLAG_Z;
      if (((a & 0xfff) + (b & 0xfff)) & 0x1000) f |= FLAG_H;
      if (a + b > 0xffff) f |= FLAG_C;
      this.f = f;
      return result;
    }
    // ADD SP,e / LD HL,SP+e share this: 8-bit signed displacement added to a 16-bit base,
    // with H/C computed from the LOW BYTE addition only (documented GB quirk).
    _addSpDisp(base, e) {
      const result = u16(base + e);
      let f = 0;
      if (((base & 0xf) + (e & 0xf)) & 0x10) f |= FLAG_H;
      if (((base & 0xff) + (e & 0xff)) & 0x100) f |= FLAG_C;
      this.f = f;
      return result;
    }

    _rlc(v) { const c = (v >>> 7) & 1; return { v: ((v << 1) | c) & 0xff, c }; }
    _rrc(v) { const c = v & 1; return { v: ((v >>> 1) | (c << 7)) & 0xff, c }; }
    _rl(v, cIn) { const c = (v >>> 7) & 1; return { v: ((v << 1) | cIn) & 0xff, c }; }
    _rr(v, cIn) { const c = v & 1; return { v: ((v >>> 1) | (cIn << 7)) & 0xff, c }; }
    _sla(v) { const c = (v >>> 7) & 1; return { v: (v << 1) & 0xff, c }; }
    _sra(v) { const c = v & 1; return { v: ((v >>> 1) | (v & 0x80)) & 0xff, c }; }
    _swap(v) { return { v: ((v << 4) | (v >>> 4)) & 0xff, c: 0 }; }
    _srl(v) { const c = v & 1; return { v: (v >>> 1) & 0xff, c }; }
    _shiftFlags(result, carry) {
      let f = carry ? FLAG_C : 0;
      if (result === 0) f |= FLAG_Z;
      this.f = f;
    }

    _daa() {
      let a = this.a;
      const n = this.f & FLAG_N;
      let adjust = 0;
      let carry = this.f & FLAG_C;
      if (this.f & FLAG_H || (!n && (a & 0xf) > 9)) adjust |= 0x06;
      if (carry || (!n && a > 0x99)) { adjust |= 0x60; carry = FLAG_C; }
      a = n ? (a - adjust) & 0xff : (a + adjust) & 0xff;
      let f = carry | n;
      if (a === 0) f |= FLAG_Z;
      this.a = a;
      this.f = f;
    }

    // Called by the host bus once it has decided (via IE&IF priority) which single vector
    // fires; this CPU has no notion of interrupt priority or the IE/IF registers itself.
    serviceVector(addr) {
      this.halted = false;
      this.ime = false;
      this._push16(this.pc);
      this.pc = addr;
      this.cycles += 20;
    }
    // HALT wakes on any pending interrupt regardless of IME (the host bus is expected to
    // call this once IE&IF becomes nonzero); it does not by itself dispatch the handler.
    wake() { this.halted = false; }

    step() {
      if (this.halted || this.stopped || this.illegal) { this.cycles += 4; return; }
      const opcode = this._fetch8();
      this._exec(opcode);
    }
    _stepFast(count) { for (let i = 0; i < count; i++) this.step(); }

    _illegalOpcode() {
      // Real hardware locks up on these; surfacing that loudly (vs. silently NOPing) makes
      // decoder bugs in this emulator visible instead of producing subtly-wrong playback.
      this.illegal = true;
      this.halted = true;
      this.cycles += 4;
    }

    _exec(opcode) {
      this.instructions++;
      if (opcode === 0xcb) { this._execCb(); return; }

      const x = (opcode >>> 6) & 3;
      const y = (opcode >>> 3) & 7;
      const z = opcode & 7;

      if (x === 1) { // LD r,r' (0x76 = HALT)
        if (y === 6 && z === 6) { this.halted = true; this.cycles += 4; return; }
        this._writeR(y, this._readR(z));
        this.cycles += (y === 6 || z === 6) ? 8 : 4;
        return;
      }
      if (x === 2) { // ALU A,r
        this._alu(y, this._readR(z));
        this.cycles += z === 6 ? 8 : 4;
        return;
      }
      if (x === 0) { this._execBlock0(y, z); return; }
      this._execBlock3(y, z);
    }

    _execBlock0(y, z) {
      if (z === 0) {
        if (y === 0) { this.cycles += 4; return; } // NOP
        if (y === 1) { const nn = this._fetch16(); const v = this.sp; this._wr(nn, v & 0xff); this._wr(u16(nn + 1), (v >>> 8) & 0xff); this.cycles += 20; return; } // LD (nn),SP
        if (y === 2) { this._fetch8(); this.stopped = true; this.cycles += 4; return; } // STOP (2-byte; not really implemented, GBS drivers don't rely on it)
        if (y === 3) { const e = signed8(this._fetch8()); this.pc = u16(this.pc + e); this.cycles += 12; return; } // JR e
        const e = signed8(this._fetch8()); // JR cc,e (cc = NZ,Z,NC,C)
        if (this._checkCond(y - 4)) { this.pc = u16(this.pc + e); this.cycles += 12; } else this.cycles += 8;
        return;
      }
      if (z === 1) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._writeRp(p, this._fetch16()); this.cycles += 12; return; } // LD rp,nn
        this.hl = this._add16(this.hl, this._readRp(p)); // ADD HL,rp
        this.cycles += 8;
        return;
      }
      if (z === 2) {
        switch (y) {
          case 0: this._wr(this.bc, this.a); this.cycles += 8; return;  // LD (BC),A
          case 1: this.a = this._rd(this.bc); this.cycles += 8; return; // LD A,(BC)
          case 2: this._wr(this.de, this.a); this.cycles += 8; return;  // LD (DE),A
          case 3: this.a = this._rd(this.de); this.cycles += 8; return; // LD A,(DE)
          case 4: this._wr(this.hl, this.a); this.hl = u16(this.hl + 1); this.cycles += 8; return; // LD (HL+),A
          case 5: this.a = this._rd(this.hl); this.hl = u16(this.hl + 1); this.cycles += 8; return; // LD A,(HL+)
          case 6: this._wr(this.hl, this.a); this.hl = u16(this.hl - 1); this.cycles += 8; return; // LD (HL-),A
          case 7: this.a = this._rd(this.hl); this.hl = u16(this.hl - 1); this.cycles += 8; return; // LD A,(HL-)
        }
        return;
      }
      if (z === 3) {
        const p = (y >>> 1) & 3, q = y & 1;
        this._writeRp(p, u16(this._readRp(p) + (q === 0 ? 1 : -1))); // INC/DEC rp
        this.cycles += 8;
        return;
      }
      if (z === 4 || z === 5) { // INC r / DEC r
        const val = this._readR(y);
        this._writeR(y, z === 4 ? this._inc8(val) : this._dec8(val));
        this.cycles += y === 6 ? 12 : 4;
        return;
      }
      if (z === 6) { // LD r,n
        const n = this._fetch8();
        this._writeR(y, n);
        this.cycles += y === 6 ? 12 : 8;
        return;
      }
      // z===7: single-byte rotates on A / DAA / CPL / SCF / CCF
      switch (y) {
        case 0: { const r = this._rlc(this.a); this.a = r.v; this.f = r.c ? FLAG_C : 0; this.cycles += 4; return; }
        case 1: { const r = this._rrc(this.a); this.a = r.v; this.f = r.c ? FLAG_C : 0; this.cycles += 4; return; }
        case 2: { const r = this._rl(this.a, this.f & FLAG_C ? 1 : 0); this.a = r.v; this.f = r.c ? FLAG_C : 0; this.cycles += 4; return; }
        case 3: { const r = this._rr(this.a, this.f & FLAG_C ? 1 : 0); this.a = r.v; this.f = r.c ? FLAG_C : 0; this.cycles += 4; return; }
        case 4: this._daa(); this.cycles += 4; return;
        case 5: this.a = (~this.a) & 0xff; this.f = (this.f & (FLAG_Z | FLAG_C)) | FLAG_N | FLAG_H; this.cycles += 4; return; // CPL
        case 6: this.f = (this.f & FLAG_Z) | FLAG_C; this.cycles += 4; return; // SCF
        case 7: this.f = (this.f & (FLAG_Z | FLAG_C)) ^ FLAG_C; this.cycles += 4; return; // CCF
      }
    }

    _execBlock3(y, z) {
      if (z === 0) {
        if (y <= 3) { if (this._checkCond(y)) { this.pc = this._pop16(); this.cycles += 20; } else this.cycles += 8; return; } // RET cc
        if (y === 4) { const n = this._fetch8(); this._wr(0xff00 + n, this.a); this.cycles += 12; return; } // LDH (n),A
        if (y === 5) { const e = signed8(this._fetch8()); this.sp = this._addSpDisp(this.sp, e); this.cycles += 16; return; } // ADD SP,e
        if (y === 6) { const n = this._fetch8(); this.a = this._rd(0xff00 + n); this.cycles += 12; return; } // LDH A,(n)
        if (y === 7) { const e = signed8(this._fetch8()); this.hl = this._addSpDisp(this.sp, e); this.cycles += 12; return; } // LD HL,SP+e
        return;
      }
      if (z === 1) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._writeRp2(p, this._pop16()); this.cycles += 12; return; } // POP rp2
        switch (p) {
          case 0: this.pc = this._pop16(); this.cycles += 16; return; // RET
          case 1: this.ime = true; this.pc = this._pop16(); this.cycles += 16; return; // RETI
          case 2: this.pc = this.hl; this.cycles += 4; return; // JP (HL)
          case 3: this.sp = this.hl; this.cycles += 8; return; // LD SP,HL
        }
        return;
      }
      if (z === 2) {
        if (y <= 3) { const nn = this._fetch16(); if (this._checkCond(y)) { this.pc = nn; this.cycles += 16; } else this.cycles += 12; return; } // JP cc,nn
        if (y === 4) { this._wr(0xff00 + this.c, this.a); this.cycles += 8; return; } // LD (C),A
        if (y === 5) { const nn = this._fetch16(); this._wr(nn, this.a); this.cycles += 16; return; } // LD (nn),A
        if (y === 6) { this.a = this._rd(0xff00 + this.c); this.cycles += 8; return; } // LD A,(C)
        if (y === 7) { const nn = this._fetch16(); this.a = this._rd(nn); this.cycles += 16; return; } // LD A,(nn)
        return;
      }
      if (z === 3) {
        if (y === 0) { this.pc = this._fetch16(); this.cycles += 16; return; } // JP nn
        if (y === 1) { this._execCb(); return; } // unreachable: 0xcb intercepted earlier
        if (y === 6) { this.ime = false; this.cycles += 4; return; } // DI
        if (y === 7) { this.ime = true; this.cycles += 4; return; } // EI
        this._illegalOpcode(); return; // y=2,3,4,5: OUT/IN/EX(SP),HL/EX DE,HL don't exist on GB
      }
      if (z === 4) { // CALL cc,nn (only NZ,Z,NC,C exist)
        if (y > 3) { this._illegalOpcode(); return; }
        const nn = this._fetch16();
        if (this._checkCond(y)) { this._push16(this.pc); this.pc = nn; this.cycles += 24; } else this.cycles += 12;
        return;
      }
      if (z === 5) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._push16(this._readRp2(p)); this.cycles += 16; return; } // PUSH rp2
        if (p === 0) { const nn = this._fetch16(); this._push16(this.pc); this.pc = nn; this.cycles += 24; return; } // CALL nn
        this._illegalOpcode(); return; // p=1,2,3 with q=1: Z80's DD/ED/FD prefixes don't exist on GB
      }
      if (z === 6) { const n = this._fetch8(); this._alu(y, n); this.cycles += 8; return; } // ALU A,n
      if (z === 7) { this._push16(this.pc); this.pc = y * 8; this.cycles += 16; return; } // RST y*8
    }

    _execCb() {
      const opcode = this._fetch8();
      const x = (opcode >>> 6) & 3;
      const y = (opcode >>> 3) & 7;
      const z = opcode & 7;
      const val = this._readR(z);
      if (x === 0) { // rotate/shift group (y=6 is SWAP, not SLL - GB has no undocumented SLL)
        let r;
        switch (y) {
          case 0: r = this._rlc(val); break;
          case 1: r = this._rrc(val); break;
          case 2: r = this._rl(val, this.f & FLAG_C ? 1 : 0); break;
          case 3: r = this._rr(val, this.f & FLAG_C ? 1 : 0); break;
          case 4: r = this._sla(val); break;
          case 5: r = this._sra(val); break;
          case 6: r = this._swap(val); break;
          case 7: r = this._srl(val); break;
        }
        this._shiftFlags(r.v, r.c);
        this._writeR(z, r.v);
        this.cycles += z === 6 ? 16 : 8;
        return;
      }
      if (x === 1) { // BIT y,r
        const bit = (val >>> y) & 1;
        this.f = (this.f & FLAG_C) | FLAG_H | (bit === 0 ? FLAG_Z : 0);
        this.cycles += z === 6 ? 12 : 8;
        return;
      }
      if (x === 2) { this._writeR(z, val & ~(1 << y)); this.cycles += z === 6 ? 16 : 8; return; } // RES y,r
      this._writeR(z, val | (1 << y)); this.cycles += z === 6 ? 16 : 8; // SET y,r
    }
  }

  const DMG_CYCLES_PER_FRAME = 70224; // ~59.7Hz synthetic vblank, matching real DMG timing
  const TAC_PERIOD = [1024, 16, 64, 256]; // CPU cycles per TIMA tick, indexed by TAC bits 0-1
  const IF_VBLANK = 0, IF_LCDSTAT = 1, IF_TIMER = 2, IF_SERIAL = 3, IF_JOYPAD = 4;
  const IRQ_VECTOR = [0x40, 0x48, 0x50, 0x58, 0x60];

  // DMG memory bus + interrupt controller + timer, for driving a GBS file's Z80 (SM83) music
  // driver headlessly (no PPU/joypad — GBS files don't need either). Wires the shared PsgDmg
  // module (psg_dmg.js) in at its native 0xFF10-0xFF3F addressing, unlike gsf_emulator.js's
  // GbaMemoryBus which has to translate a differently-laid-out register map.
  class DmgMemoryBus {
    constructor(romBytes, { cpuHz = 4194304 } = {}) {
      this.cpuHz = cpuHz;
      const bytes = romBytes instanceof Uint8Array ? romBytes : new Uint8Array(romBytes || 0);
      this.bankCount = Math.max(2, Math.ceil(bytes.length / 0x4000));
      this.rom = new Uint8Array(this.bankCount * 0x4000);
      this.rom.set(bytes.subarray(0, Math.min(bytes.length, this.rom.length)));
      this.romBank = 1; // MBC5-style single bank-select register (0x2000-0x3FFF), per the
                         // simple bank-switching convention real .gbs rips assume
      this.wram = new Uint8Array(0x2000); // 8KB, 0xC000-0xDFFF, mirrored at 0xE000-0xFDFF
      this.hram = new Uint8Array(0x7f);   // 0xFF80-0xFFFE
      this.io = new Uint8Array(0x80);     // 0xFF00-0xFF7F, for registers PsgDmg/timer don't own
      this.ie = 0;   // 0xFFFF
      this.if_ = 0;  // 0xFF0F, bits 0-4 = VBlank/LCDSTAT/Timer/Serial/Joypad
      this.psg = new window.PsgDmg({ cpuHz });
      this.cycles = 0;
      this.divCounter = 0;
      this.timaCounter = 0;
      this.frameCounter = 0;
    }

    _bankOffset(addr) { return this.romBank * 0x4000 + (addr - 0x4000); }

    read8(addr) {
      addr &= 0xffff;
      if (addr < 0x4000) return this.rom[addr] || 0; // fixed bank 0
      if (addr < 0x8000) return this.rom[this._bankOffset(addr) % this.rom.length] || 0; // switchable bank
      if (addr >= 0xc000 && addr < 0xe000) return this.wram[addr - 0xc000];
      if (addr >= 0xe000 && addr < 0xfe00) return this.wram[addr - 0xe000]; // echo RAM
      if (addr >= 0xff10 && addr <= 0xff23) return this.psg.readReg(addr - 0xff10);
      if (addr >= 0xff30 && addr <= 0xff3f) return this.psg.readWave(addr - 0xff30);
      if (addr === 0xff04) return (this.divCounter >>> 8) & 0xff; // DIV = high byte of the internal counter
      if (addr === 0xff05) return this.io[0x05]; // TIMA
      if (addr === 0xff06) return this.io[0x06]; // TMA
      if (addr === 0xff07) return this.io[0x07]; // TAC
      if (addr === 0xff0f) return this.if_ & 0x1f;
      if (addr === 0xffff) return this.ie & 0x1f;
      if (addr >= 0xff80 && addr <= 0xfffe) return this.hram[addr - 0xff80];
      if (addr >= 0xff00 && addr < 0xff80) return this.io[addr - 0xff00];
      return 0xff; // unmapped (no PPU/joypad/serial hardware backing this headless bus)
    }

    write8(addr, value) {
      addr &= 0xffff; value &= 0xff;
      if (addr >= 0x2000 && addr < 0x4000) { this.romBank = value % this.bankCount; return; } // MBC5-style bank select (unlike MBC1, bank 0 is a valid switchable-window value)
      if (addr < 0x8000) return; // other ROM-area writes are bank-control regs this simple loader doesn't need
      if (addr >= 0xc000 && addr < 0xe000) { this.wram[addr - 0xc000] = value; return; }
      if (addr >= 0xe000 && addr < 0xfe00) { this.wram[addr - 0xe000] = value; return; }
      if (addr >= 0xff10 && addr <= 0xff23) { this.psg.writeReg(addr - 0xff10, value, this.cycles); return; }
      if (addr >= 0xff30 && addr <= 0xff3f) { this.psg.writeWave(addr - 0xff30, value); return; }
      if (addr === 0xff04) { this.divCounter = 0; return; } // any write resets DIV
      if (addr === 0xff05) { this.io[0x05] = value; return; }
      if (addr === 0xff06) { this.io[0x06] = value; return; }
      if (addr === 0xff07) { this.io[0x07] = value & 0x07; return; }
      if (addr === 0xff0f) { this.if_ = value & 0x1f; return; }
      if (addr === 0xffff) { this.ie = value & 0x1f; return; }
      if (addr >= 0xff80 && addr <= 0xfffe) { this.hram[addr - 0xff80] = value; return; }
      if (addr >= 0xff00 && addr < 0xff80) { this.io[addr - 0xff00] = value; return; }
    }

    requestInterrupt(bit) { this.if_ |= (1 << bit); }

    // Advances DIV/TIMA/synthetic-vblank timing and the shared PSG's frame sequencer by
    // deltaCycles (the cycle cost of the instruction the CPU just executed). Call once per
    // cpu.step() from the host engine's run loop.
    tick(deltaCycles, cpu) {
      this.cycles += deltaCycles;
      this.divCounter = (this.divCounter + deltaCycles) & 0xffff;

      const tac = this.io[0x07];
      if (tac & 0x04) {
        this.timaCounter += deltaCycles;
        const period = TAC_PERIOD[tac & 0x03];
        while (this.timaCounter >= period) {
          this.timaCounter -= period;
          const next = (this.io[0x05] + 1) & 0xff;
          if (next === 0) { this.io[0x05] = this.io[0x06]; this.requestInterrupt(IF_TIMER); }
          else this.io[0x05] = next;
        }
      }

      this.frameCounter += deltaCycles;
      while (this.frameCounter >= DMG_CYCLES_PER_FRAME) {
        this.frameCounter -= DMG_CYCLES_PER_FRAME;
        this.requestInterrupt(IF_VBLANK);
      }

      this.psg.stepCycles(this.cycles);

      if (cpu) this.serviceInterrupts(cpu);
    }

    // Fixed-vector dispatch per real DMG semantics: on any pending IE&IF bit, a halted CPU
    // wakes regardless of IME; the actual jump-to-handler only happens if IME is set, and
    // only the single highest-priority pending bit (lowest bit index) is serviced per call.
    serviceInterrupts(cpu) {
      const pending = this.ie & this.if_ & 0x1f;
      if (!pending) return;
      if (cpu.halted) cpu.wake();
      if (!cpu.ime) return;
      for (let bit = 0; bit < 5; bit++) {
        if (pending & (1 << bit)) {
          this.if_ &= ~(1 << bit);
          cpu.serviceVector(IRQ_VECTOR[bit]);
          return;
        }
      }
    }

    // Simple stereo mix of the 4 PSG channels per NR50 (master volume)/NR51 (panning),
    // analogous to gsf_emulator.js's _mixPsgInto but for real DMG's simpler additive mixer
    // (no separate Direct Sound path to blend against, since GBS has no PCM/FIFO channels).
    mixSample() {
      const nr50 = this.io[0x24] || 0, nr51 = this.io[0x25] || 0;
      const rightVol = (nr50 & 0x07) + 1, leftVol = ((nr50 >>> 4) & 0x07) + 1;
      const out = this.psg.outputsAt(this.cycles);
      let right = 0, left = 0;
      for (let ch = 0; ch < 4; ch++) {
        if (nr51 & (1 << ch)) right += out[ch];
        if (nr51 & (1 << (ch + 4))) left += out[ch];
      }
      return [(left * leftVol) / 32, (right * rightVol) / 32];
    }
  }

  // Hand-assembled smoke check exercising representative GB-specific opcodes (LDH, HL+/-,
  // flag layout) alongside ordinary load/arithmetic/jump/call. Mirrors Arm7Cpu's selfTest()
  // pattern (gsf_emulator.js) — first target for test/smoke.js.
  function selfTest() {
    const mem = new Uint8Array(0x10000);
    const bus = {
      read8: (a) => mem[a & 0xffff],
      write8: (a, v) => { mem[a & 0xffff] = v & 0xff; },
    };
    const cpu = new Sm83Cpu(bus);
    cpu.pc = 0x0000;
    // LD A,0x42 ; LD B,0x01 ; ADD A,B ; LD (HL+),A [HL=0x8000] ; LDH (0x10),A ; HALT
    const prog = [
      0x3e, 0x42,       // LD A,0x42
      0x06, 0x01,       // LD B,0x01
      0x80,             // ADD A,B
      0x21, 0x00, 0x80, // LD HL,0x8000
      0x22,             // LD (HL+),A
      0xe0, 0x10,       // LDH (0x10),A  -> writes 0xff10
      0x76,             // HALT
    ];
    mem.set(prog, 0);
    for (let i = 0; i < 200 && !cpu.halted; i++) cpu.step();
    return { a: cpu.a, hl: cpu.hl, mem8000: mem[0x8000], mem_ff10: mem[0xff10], halted: cpu.halted };
  }

  window.Z80Emulator = { Sm83Cpu, DmgMemoryBus, selfTest };
})();
