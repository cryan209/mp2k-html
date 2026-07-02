// Standard Zilog Z80 CPU core, written for GBS (Game Boy Sound) playback: GBS files
// contain Z80 machine code for the original DMG music driver. Structured like Arm7Cpu/
// GbaMemoryBus in gsf_emulator.js (register file, bus abstraction, cycle counting,
// step()/_stepFast() dispatch) but implements a completely different ISA, so no code is
// shared between the two cores.
//
// Bus contract: bus.read8(addr)/bus.write8(addr,value) for the 16-bit memory space,
// bus.ioIn(port)/bus.ioOut(port,value) for the 8-bit I/O space (rarely used by GBS
// drivers, but implemented for completeness since hand-written driver code can use
// nearly anything).
(function () {
  const FLAG_C = 0x01, FLAG_N = 0x02, FLAG_PV = 0x04, FLAG_X = 0x08,
        FLAG_H = 0x10, FLAG_Y = 0x20, FLAG_Z = 0x40, FLAG_S = 0x80;

  const PARITY = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i, bits = 0;
    for (let b = 0; b < 8; b++) { bits ^= (v & 1); v >>= 1; }
    PARITY[i] = bits ? 0 : FLAG_PV; // even parity -> P/V set
  }

  const CC_NAMES = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

  function u8(v) { return v & 0xff; }
  function u16(v) { return v & 0xffff; }
  function signed8(v) { return (v & 0x80) ? (v - 256) : v; }

  class Z80Cpu {
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.a = 0; this.f = 0; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
      this.a2 = 0; this.f2 = 0; this.b2 = 0; this.c2 = 0; this.d2 = 0; this.e2 = 0; this.h2 = 0; this.l2 = 0;
      this.ix = 0; this.iy = 0; this.sp = 0xffff; this.pc = 0;
      this.i = 0; this.r = 0;
      this.iff1 = false; this.iff2 = false; this.im = 0;
      this.halted = false;
      this.cycles = 0;
      this.pendingIrq = false; this.irqVector = 0;
      this.pendingNmi = false;
      this.instructions = 0;
    }

    // --- 16-bit pair accessors ---
    get bc() { return (this.b << 8) | this.c; }
    set bc(v) { this.b = (v >>> 8) & 0xff; this.c = v & 0xff; }
    get de() { return (this.d << 8) | this.e; }
    set de(v) { this.d = (v >>> 8) & 0xff; this.e = v & 0xff; }
    get hl() { return (this.h << 8) | this.l; }
    set hl(v) { this.h = (v >>> 8) & 0xff; this.l = v & 0xff; }
    get af() { return (this.a << 8) | this.f; }
    set af(v) { this.a = (v >>> 8) & 0xff; this.f = v & 0xff; }

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

    _bumpR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f); }

    // --- 8-bit register-by-index access (r index 0-7: B,C,D,E,H,L,(HL),A), with an
    // optional IX/IY prefix context that substitutes H/L for IXH/IXL/IYH/IYL and (HL)
    // for (IX+d)/(IY+d). `xy` is null, 'ix', or 'iy'; `disp`, if given, is the already-
    // fetched displacement byte for a (IX+d)/(IY+d) access.
    _readR(idx, xy, disp) {
      switch (idx) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return xy === 'ix' ? (this.ix >>> 8) & 0xff : xy === 'iy' ? (this.iy >>> 8) & 0xff : this.h;
        case 5: return xy === 'ix' ? this.ix & 0xff : xy === 'iy' ? this.iy & 0xff : this.l;
        case 6: {
          const addr = xy ? u16((xy === 'ix' ? this.ix : this.iy) + disp) : this.hl;
          return this._rd(addr);
        }
        case 7: return this.a;
      }
    }
    _writeR(idx, val, xy, disp) {
      val &= 0xff;
      switch (idx) {
        case 0: this.b = val; break;
        case 1: this.c = val; break;
        case 2: this.d = val; break;
        case 3: this.e = val; break;
        case 4:
          if (xy === 'ix') this.ix = (this.ix & 0x00ff) | (val << 8);
          else if (xy === 'iy') this.iy = (this.iy & 0x00ff) | (val << 8);
          else this.h = val;
          break;
        case 5:
          if (xy === 'ix') this.ix = (this.ix & 0xff00) | val;
          else if (xy === 'iy') this.iy = (this.iy & 0xff00) | val;
          else this.l = val;
          break;
        case 6: {
          const addr = xy ? u16((xy === 'ix' ? this.ix : this.iy) + disp) : this.hl;
          this._wr(addr, val);
          break;
        }
        case 7: this.a = val; break;
      }
    }

    // 16-bit register-pair-by-index (rp index 0-3: BC,DE,HL,SP), substituting HL for
    // IX/IY under a prefix.
    _readRp(idx, xy) {
      switch (idx) {
        case 0: return this.bc;
        case 1: return this.de;
        case 2: return xy === 'ix' ? this.ix : xy === 'iy' ? this.iy : this.hl;
        case 3: return this.sp;
      }
    }
    _writeRp(idx, val, xy) {
      val = u16(val);
      switch (idx) {
        case 0: this.bc = val; break;
        case 1: this.de = val; break;
        case 2: if (xy === 'ix') this.ix = val; else if (xy === 'iy') this.iy = val; else this.hl = val; break;
        case 3: this.sp = val; break;
      }
    }
    // rp2 index 0-3 for PUSH/POP: BC,DE,HL,AF
    _readRp2(idx, xy) {
      if (idx === 3) return this.af;
      return this._readRp(idx, xy);
    }
    _writeRp2(idx, val, xy) {
      if (idx === 3) { this.af = val; return; }
      this._writeRp(idx, val, xy);
    }

    _checkCond(cc) {
      switch (cc) {
        case 0: return !(this.f & FLAG_Z);   // NZ
        case 1: return !!(this.f & FLAG_Z);  // Z
        case 2: return !(this.f & FLAG_C);   // NC
        case 3: return !!(this.f & FLAG_C);  // C
        case 4: return !(this.f & FLAG_PV);  // PO
        case 5: return !!(this.f & FLAG_PV); // PE
        case 6: return !(this.f & FLAG_S);   // P
        case 7: return !!(this.f & FLAG_S);  // M
      }
    }

    // --- 8-bit ALU ---
    _alu(op, val) {
      const a = this.a;
      switch (op) {
        case 0: this._add8(val, 0); break;                 // ADD
        case 1: this._add8(val, this.f & FLAG_C ? 1 : 0); break; // ADC
        case 2: this._sub8(val, 0); break;                 // SUB
        case 3: this._sub8(val, this.f & FLAG_C ? 1 : 0); break; // SBC
        case 4: this._logic8(a & val, true); break;         // AND
        case 5: this._logic8(a ^ val, false); break;         // XOR
        case 6: this._logic8(a | val, false); break;         // OR
        case 7: this._cp8(val); break;                       // CP
      }
    }

    _add8(val, carryIn) {
      const a = this.a;
      const sum = a + val + carryIn;
      const result = sum & 0xff;
      let f = 0;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) + (val & 0xf) + carryIn) & 0x10) f |= FLAG_H;
      if (((a ^ val ^ 0x80) & (result ^ a) & 0x80)) f |= FLAG_PV;
      if (sum > 0xff) f |= FLAG_C;
      f |= result & (FLAG_X | FLAG_Y);
      this.a = result;
      this.f = f;
    }
    _sub8(val, carryIn) {
      const a = this.a;
      const diff = a - val - carryIn;
      const result = diff & 0xff;
      let f = FLAG_N;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) - (val & 0xf) - carryIn) & 0x10) f |= FLAG_H;
      if (((a ^ val) & (result ^ a) & 0x80)) f |= FLAG_PV;
      if (diff < 0) f |= FLAG_C;
      f |= result & (FLAG_X | FLAG_Y);
      this.a = result;
      this.f = f;
    }
    _cp8(val) {
      const a = this.a;
      const diff = a - val;
      const result = diff & 0xff;
      let f = FLAG_N;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xf) - (val & 0xf)) & 0x10) f |= FLAG_H;
      if (((a ^ val) & (result ^ a) & 0x80)) f |= FLAG_PV;
      if (diff < 0) f |= FLAG_C;
      // CP's undocumented X/Y flags come from the operand, not the result.
      f |= val & (FLAG_X | FLAG_Y);
      this.f = f;
    }
    _logic8(result, isAnd) {
      result &= 0xff;
      let f = isAnd ? FLAG_H : 0;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      f |= PARITY[result];
      f |= result & (FLAG_X | FLAG_Y);
      this.a = result;
      this.f = f;
    }
    _inc8(val) {
      const result = (val + 1) & 0xff;
      let f = this.f & FLAG_C;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if ((val & 0xf) === 0xf) f |= FLAG_H;
      if (val === 0x7f) f |= FLAG_PV;
      f |= result & (FLAG_X | FLAG_Y);
      this.f = f;
      return result;
    }
    _dec8(val) {
      const result = (val - 1) & 0xff;
      let f = (this.f & FLAG_C) | FLAG_N;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if ((val & 0xf) === 0) f |= FLAG_H;
      if (val === 0x80) f |= FLAG_PV;
      f |= result & (FLAG_X | FLAG_Y);
      this.f = f;
      return result;
    }

    // --- 16-bit ALU ---
    _add16(a, b) {
      const result = (a + b) & 0xffff;
      let f = this.f & (FLAG_S | FLAG_Z | FLAG_PV);
      if (((a & 0xfff) + (b & 0xfff)) & 0x1000) f |= FLAG_H;
      if (a + b > 0xffff) f |= FLAG_C;
      f |= (result >>> 8) & (FLAG_X | FLAG_Y);
      this.f = f;
      return result;
    }
    _adc16(a, b) {
      const carry = this.f & FLAG_C ? 1 : 0;
      const sum = a + b + carry;
      const result = sum & 0xffff;
      let f = 0;
      if (result & 0x8000) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xfff) + (b & 0xfff) + carry) & 0x1000) f |= FLAG_H;
      if (((a ^ b ^ 0x8000) & (result ^ a) & 0x8000)) f |= FLAG_PV;
      if (sum > 0xffff) f |= FLAG_C;
      f |= (result >>> 8) & (FLAG_X | FLAG_Y);
      this.f = f;
      return result;
    }
    _sbc16(a, b) {
      const carry = this.f & FLAG_C ? 1 : 0;
      const diff = a - b - carry;
      const result = diff & 0xffff;
      let f = FLAG_N;
      if (result & 0x8000) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      if (((a & 0xfff) - (b & 0xfff) - carry) & 0x1000) f |= FLAG_H;
      if (((a ^ b) & (result ^ a) & 0x8000)) f |= FLAG_PV;
      if (diff < 0) f |= FLAG_C;
      f |= (result >>> 8) & (FLAG_X | FLAG_Y);
      this.f = f;
      return result;
    }

    // --- Rotate/shift helpers, shared by RLCA-family and CB-prefixed group ---
    _rlc(v) { const c = (v >>> 7) & 1; return { v: ((v << 1) | c) & 0xff, c }; }
    _rrc(v) { const c = v & 1; return { v: ((v >>> 1) | (c << 7)) & 0xff, c }; }
    _rl(v, cIn) { const c = (v >>> 7) & 1; return { v: ((v << 1) | cIn) & 0xff, c }; }
    _rr(v, cIn) { const c = v & 1; return { v: ((v >>> 1) | (cIn << 7)) & 0xff, c }; }
    _sla(v) { const c = (v >>> 7) & 1; return { v: (v << 1) & 0xff, c }; }
    _sra(v) { const c = v & 1; return { v: ((v >>> 1) | (v & 0x80)) & 0xff, c }; }
    _sll(v) { const c = (v >>> 7) & 1; return { v: ((v << 1) | 1) & 0xff, c }; } // undocumented
    _srl(v) { const c = v & 1; return { v: (v >>> 1) & 0xff, c }; }

    _shiftFlags(result, carry) {
      let f = carry;
      if (result & 0x80) f |= FLAG_S;
      if (result === 0) f |= FLAG_Z;
      f |= PARITY[result];
      f |= result & (FLAG_X | FLAG_Y);
      this.f = f;
    }

    // --- Interrupts ---
    requestIrq(vector = 0xff) { this.pendingIrq = true; this.irqVector = vector & 0xff; }
    requestNmi() { this.pendingNmi = true; }

    _serviceInterrupts() {
      if (this.pendingNmi) {
        this.pendingNmi = false;
        this.halted = false;
        this.iff2 = this.iff1;
        this.iff1 = false;
        this._push16(this.pc);
        this.pc = 0x0066;
        this.cycles += 11;
        return true;
      }
      if (this.pendingIrq && this.iff1) {
        this.pendingIrq = false;
        this.halted = false;
        this.iff1 = false;
        this.iff2 = false;
        if (this.im === 1) {
          this._push16(this.pc);
          this.pc = 0x0038;
          this.cycles += 13;
        } else if (this.im === 2) {
          const vecAddr = ((this.i << 8) | this.irqVector) & 0xffff;
          this._push16(this.pc);
          this.pc = this._rd(vecAddr) | (this._rd(u16(vecAddr + 1)) << 8);
          this.cycles += 19;
        } else {
          // IM 0: GBS drivers don't push a real bus instruction, so treat as RST 38
          // (the common real-world fallback most DMG-era code paths expect).
          this._push16(this.pc);
          this.pc = 0x0038;
          this.cycles += 13;
        }
        return true;
      }
      return false;
    }

    step() {
      if (this._serviceInterrupts()) return;
      if (this.halted) {
        this._bumpR();
        this.cycles += 4;
        return;
      }
      this._bumpR();
      const opcode = this._fetch8();
      this._exec(opcode, null, 0);
    }

    // Batch execution entry point mirroring Arm7Cpu's _stepFast, for the streaming pump.
    _stepFast(count) {
      for (let i = 0; i < count; i++) this.step();
    }

    _exec(opcode, xy, prefixCycles) {
      this.instructions++;
      if (opcode === 0xcb) { this._execCb(xy); return; }
      if (opcode === 0xed) { this._execEd(); return; }
      if (opcode === 0xdd) { this._bumpR(); this._exec(this._fetch8(), 'ix', prefixCycles + 4); return; }
      if (opcode === 0xfd) { this._bumpR(); this._exec(this._fetch8(), 'iy', prefixCycles + 4); return; }

      const x = (opcode >>> 6) & 3;
      const y = (opcode >>> 3) & 7;
      const z = opcode & 7;

      // x=1: LD r,r' (0x76 = HALT)
      if (x === 1) {
        if (y === 6 && z === 6) { this.halted = true; this.cycles += 4 + prefixCycles; return; }
        let disp = 0;
        if (xy && (y === 6 || z === 6)) disp = signed8(this._fetch8());
        const val = this._readR(z, xy, disp);
        this._writeR(y, val, xy, disp);
        this.cycles += (y === 6 || z === 6) ? (xy ? 19 : 7) : (xy && (y < 4 || y > 5) === false ? 8 : (xy ? 8 : 4));
        return;
      }
      // x=2: ALU A, r
      if (x === 2) {
        let disp = 0;
        if (xy && z === 6) disp = signed8(this._fetch8());
        const val = this._readR(z, xy, disp);
        this._alu(y, val);
        this.cycles += z === 6 ? (xy ? 19 : 7) : (xy ? 8 : 4);
        return;
      }
      // x=0 and x=3: everything else
      if (x === 0) { this._execBlock0(y, z, xy, prefixCycles); return; }
      this._execBlock3(y, z, xy, prefixCycles);
    }

    _execBlock0(y, z, xy, prefixCycles) {
      if (z === 0) {
        if (y === 0) { this.cycles += 4 + prefixCycles; return; } // NOP
        if (y === 1) { // EX AF,AF'
          const a = this.a, f = this.f; this.a = this.a2; this.f = this.f2; this.a2 = a; this.f2 = f;
          this.cycles += 4; return;
        }
        if (y === 2) { // DJNZ e
          const e = signed8(this._fetch8());
          this.b = (this.b - 1) & 0xff;
          if (this.b !== 0) { this.pc = u16(this.pc + e); this.cycles += 13; } else this.cycles += 8;
          return;
        }
        if (y === 3) { const e = signed8(this._fetch8()); this.pc = u16(this.pc + e); this.cycles += 12; return; } // JR e
        // y=4..7: JR cc,e (cc = NZ,Z,NC,C)
        const e = signed8(this._fetch8());
        if (this._checkCond(y - 4)) { this.pc = u16(this.pc + e); this.cycles += 12; } else this.cycles += 7;
        return;
      }
      if (z === 1) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._writeRp(p, this._fetch16(), xy); this.cycles += 10 + prefixCycles; return; } // LD rp,nn
        const hl = this._readRp(2, xy);
        this._writeRp(2, this._add16(hl, this._readRp(p, xy)), xy); // ADD HL/IX/IY,rp
        this.cycles += 11 + prefixCycles;
        return;
      }
      if (z === 2) {
        // indirect loads: (BC)/(DE)/(nn) with A, and (nn) with HL/IX/IY
        switch (y) {
          case 0: this._wr(this.bc, this.a); this.cycles += 7; return;
          case 1: this.a = this._rd(this.bc); this.cycles += 7; return;
          case 2: this._wr(this.de, this.a); this.cycles += 7; return;
          case 3: this.a = this._rd(this.de); this.cycles += 7; return;
          case 4: { const nn = this._fetch16(); const v = this._readRp(2, xy); this._wr(nn, v & 0xff); this._wr(u16(nn + 1), (v >>> 8) & 0xff); this.cycles += 16 + prefixCycles; return; }
          case 5: { const nn = this._fetch16(); const lo = this._rd(nn), hi = this._rd(u16(nn + 1)); this._writeRp(2, (hi << 8) | lo, xy); this.cycles += 16 + prefixCycles; return; }
          case 6: { const nn = this._fetch16(); this._wr(nn, this.a); this.cycles += 13; return; }
          case 7: { const nn = this._fetch16(); this.a = this._rd(nn); this.cycles += 13; return; }
        }
        return;
      }
      if (z === 3) {
        const p = (y >>> 1) & 3, q = y & 1;
        const v = this._readRp(p, xy);
        this._writeRp(p, u16(v + (q === 0 ? 1 : -1)), xy); // INC/DEC rp
        this.cycles += 6 + prefixCycles;
        return;
      }
      if (z === 4 || z === 5) {
        // INC r / DEC r (y = target reg index)
        let disp = 0;
        if (xy && y === 6) disp = signed8(this._fetch8());
        const val = this._readR(y, xy, disp);
        const result = z === 4 ? this._inc8(val) : this._dec8(val);
        this._writeR(y, result, xy, disp);
        this.cycles += y === 6 ? (xy ? 23 : 11) : (xy ? 8 : 4);
        return;
      }
      if (z === 6) {
        // LD r,n
        let disp = 0;
        if (xy && y === 6) disp = signed8(this._fetch8());
        const n = this._fetch8();
        this._writeR(y, n, xy, disp);
        this.cycles += y === 6 ? (xy ? 19 : 10) : (xy ? 11 : 7);
        return;
      }
      // z===7: assorted single-byte rotates/DAA/CPL/SCF/CCF
      switch (y) {
        case 0: { const r = this._rlc(this.a); this.a = r.v; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | r.c | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return; }
        case 1: { const r = this._rrc(this.a); this.a = r.v; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | r.c | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return; }
        case 2: { const r = this._rl(this.a, this.f & FLAG_C ? 1 : 0); this.a = r.v; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | r.c | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return; }
        case 3: { const r = this._rr(this.a, this.f & FLAG_C ? 1 : 0); this.a = r.v; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | r.c | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return; }
        case 4: this._daa(); this.cycles += 4; return;
        case 5: this.a = (~this.a) & 0xff; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV | FLAG_C)) | FLAG_N | FLAG_H | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return;
        case 6: this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | FLAG_C | (this.a & (FLAG_X | FLAG_Y)); this.cycles += 4; return;
        case 7: {
          const oldC = this.f & FLAG_C;
          this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (oldC ? FLAG_H : 0) | (oldC ? 0 : FLAG_C) | (this.a & (FLAG_X | FLAG_Y));
          this.f ^= FLAG_C; // toggle carry (oldC=0 -> set C; oldC=1 -> clear C, set H copy of old C already handled)
          this.cycles += 4;
          return;
        }
      }
    }

    _daa() {
      let a = this.a;
      const n = this.f & FLAG_N;
      const c = this.f & FLAG_C;
      const h = this.f & FLAG_H;
      let adjust = 0;
      let carry = c;
      if (h || (!n && (a & 0xf) > 9)) adjust |= 0x06;
      if (c || (!n && a > 0x99)) { adjust |= 0x60; carry = FLAG_C; }
      a = n ? (a - adjust) & 0xff : (a + adjust) & 0xff;
      let f = carry | n;
      if (a & 0x80) f |= FLAG_S;
      if (a === 0) f |= FLAG_Z;
      // H flag after DAA: set if there was a half-borrow/carry in the low nibble adjustment.
      const halfChanged = n ? (h && (this.a & 0xf) < 6) : ((this.a & 0xf) > 9);
      if (halfChanged) f |= FLAG_H;
      f |= PARITY[a];
      f |= a & (FLAG_X | FLAG_Y);
      this.a = a;
      this.f = f;
    }

    _execBlock3(y, z, xy, prefixCycles) {
      if (z === 0) { // RET cc
        if (this._checkCond(y)) { this.pc = this._pop16(); this.cycles += 11; } else this.cycles += 5;
        return;
      }
      if (z === 1) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._writeRp2(p, this._pop16(), xy); this.cycles += 10 + prefixCycles; return; } // POP rp2
        switch (p) {
          case 0: this.pc = this._pop16(); this.cycles += 10; return; // RET
          case 1: { // EXX
            let t = this.b; this.b = this.b2; this.b2 = t;
            t = this.c; this.c = this.c2; this.c2 = t;
            t = this.d; this.d = this.d2; this.d2 = t;
            t = this.e; this.e = this.e2; this.e2 = t;
            t = this.h; this.h = this.h2; this.h2 = t;
            t = this.l; this.l = this.l2; this.l2 = t;
            this.cycles += 4; return;
          }
          case 2: this.pc = this._readRp(2, xy); this.cycles += 4 + prefixCycles; return; // JP (HL)/(IX)/(IY)
          case 3: this.sp = this._readRp(2, xy); this.cycles += 6 + prefixCycles; return; // LD SP,HL/IX/IY
        }
        return;
      }
      if (z === 2) { const nn = this._fetch16(); if (this._checkCond(y)) this.pc = nn; this.cycles += 10; return; } // JP cc,nn
      if (z === 3) {
        switch (y) {
          case 0: this.pc = this._fetch16(); this.cycles += 10; return; // JP nn
          // case 1 (opcode 0xcb) is intercepted in _exec() before reaching this dispatch.
          case 2: { const n = this._fetch8(); this.bus.ioOut ? this.bus.ioOut(n, this.a) : 0; this.cycles += 11; return; } // OUT (n),A
          case 3: { const n = this._fetch8(); this.a = this.bus.ioIn ? this.bus.ioIn(n) & 0xff : 0; this.cycles += 11; return; } // IN A,(n)
          case 4: { // EX (SP),HL/IX/IY
            const addr = this.sp;
            const lo = this._rd(addr), hi = this._rd(u16(addr + 1));
            const v = this._readRp(2, xy);
            this._wr(addr, v & 0xff); this._wr(u16(addr + 1), (v >>> 8) & 0xff);
            this._writeRp(2, (hi << 8) | lo, xy);
            this.cycles += 19 + prefixCycles; return;
          }
          case 5: { const de = this.de; this.de = this._readRp(2, xy); this._writeRp(2, de, xy); this.cycles += 4; return; } // EX DE,HL
          case 6: this.iff1 = false; this.iff2 = false; this.cycles += 4; return; // DI
          case 7: this.iff1 = true; this.iff2 = true; this.cycles += 4; return; // EI
        }
        return;
      }
      if (z === 4) { const nn = this._fetch16(); if (this._checkCond(y)) { this._push16(this.pc); this.pc = nn; this.cycles += 17; } else this.cycles += 10; return; } // CALL cc,nn
      if (z === 5) {
        const p = (y >>> 1) & 3, q = y & 1;
        if (q === 0) { this._push16(this._readRp2(p, xy)); this.cycles += 11 + prefixCycles; return; } // PUSH rp2
        if (p === 0) { const nn = this._fetch16(); this._push16(this.pc); this.pc = nn; this.cycles += 17; return; } // CALL nn
        return; // p=1,2,3 with q=1 are DD/ED/FD prefixes, handled earlier
      }
      if (z === 6) { const n = this._fetch8(); this._alu(y, n); this.cycles += 7; return; } // ALU A,n
      if (z === 7) { this._push16(this.pc); this.pc = y * 8; this.cycles += 11; return; } // RST y*8
    }

    _execCb(xy) {
      let disp = 0;
      if (xy) disp = signed8(this._fetch8());
      this._bumpR();
      const opcode = this._fetch8();
      const x = (opcode >>> 6) & 3;
      const y = (opcode >>> 3) & 7;
      const z = opcode & 7;
      const val = this._readR(z, xy, disp);
      const writeBack = (result) => {
        this._writeR(z, result, xy, disp);
        // DD/FD CB undocumented behavior: rotate/shift/RES/SET results also copy into an
        // 8-bit register when z!=6 would already be that register; when using (IX+d)/(IY+d)
        // (z always encodes memory in the 4-byte DDCB/FDCB form) some silicon additionally
        // writes into register y for x=0/x=2/x=3. Not required for correct GBS driver
        // behavior (documented programs never rely on it), so intentionally omitted.
      };
      if (x === 0) { // rotate/shift group
        let r;
        switch (y) {
          case 0: r = this._rlc(val); break;
          case 1: r = this._rrc(val); break;
          case 2: r = this._rl(val, this.f & FLAG_C ? 1 : 0); break;
          case 3: r = this._rr(val, this.f & FLAG_C ? 1 : 0); break;
          case 4: r = this._sla(val); break;
          case 5: r = this._sra(val); break;
          case 6: r = this._sll(val); break;
          case 7: r = this._srl(val); break;
        }
        this._shiftFlags(r.v, r.c);
        writeBack(r.v);
        this.cycles += z === 6 ? (xy ? 23 : 15) : (xy ? 23 : 8);
        return;
      }
      if (x === 1) { // BIT y,r
        const bit = (val >>> y) & 1;
        let f = (this.f & FLAG_C) | FLAG_H;
        if (bit === 0) f |= FLAG_Z | FLAG_PV;
        if (y === 7 && bit) f |= FLAG_S;
        // undocumented X/Y flags: from the tested value normally, or from the high byte of
        // the effective address when operating through (IX+d)/(IY+d).
        f |= (z === 6 ? val : val) & (FLAG_X | FLAG_Y);
        this.f = f;
        this.cycles += z === 6 ? (xy ? 20 : 12) : (xy ? 20 : 8);
        return;
      }
      if (x === 2) { // RES y,r
        writeBack(val & ~(1 << y));
        this.cycles += z === 6 ? (xy ? 23 : 15) : (xy ? 23 : 8);
        return;
      }
      // x===3: SET y,r
      writeBack(val | (1 << y));
      this.cycles += z === 6 ? (xy ? 23 : 15) : (xy ? 23 : 8);
    }

    _execEd() {
      this._bumpR();
      const opcode = this._fetch8();
      const x = (opcode >>> 6) & 3;
      const y = (opcode >>> 3) & 7;
      const z = opcode & 7;

      if (x === 1) {
        if (z === 0) { // IN r,(C) (y=6 form sets flags only, "IN F,(C)")
          const v = (this.bus.ioIn ? this.bus.ioIn(this.c) : 0xff) & 0xff;
          if (y !== 6) this._writeR(y, v, null, 0);
          let f = (this.f & FLAG_C);
          if (v & 0x80) f |= FLAG_S;
          if (v === 0) f |= FLAG_Z;
          f |= PARITY[v];
          f |= v & (FLAG_X | FLAG_Y);
          this.f = f;
          this.cycles += 12; return;
        }
        if (z === 1) { // OUT (C),r (y=6 outputs 0)
          const v = y === 6 ? 0 : this._readR(y, null, 0);
          if (this.bus.ioOut) this.bus.ioOut(this.c, v);
          this.cycles += 12; return;
        }
        if (z === 2) { // ADC/SBC HL,rp
          const p = (y >>> 1) & 3, q = y & 1;
          const rp = this._readRp(p, null);
          this.hl = q === 1 ? this._adc16(this.hl, rp) : this._sbc16(this.hl, rp);
          this.cycles += 15; return;
        }
        if (z === 3) { // LD (nn),rp / LD rp,(nn)
          const p = (y >>> 1) & 3, q = y & 1;
          const nn = this._fetch16();
          if (q === 0) { const v = this._readRp(p, null); this._wr(nn, v & 0xff); this._wr(u16(nn + 1), (v >>> 8) & 0xff); }
          else { const lo = this._rd(nn), hi = this._rd(u16(nn + 1)); this._writeRp(p, (hi << 8) | lo, null); }
          this.cycles += 20; return;
        }
        if (z === 4) { // NEG
          const a = this.a; this.a = 0; this._sub8(a, 0); this.cycles += 8; return;
        }
        if (z === 5) { // RETN / RETI
          this.iff1 = this.iff2;
          this.pc = this._pop16();
          this.cycles += 14; return;
        }
        if (z === 6) { // IM 0/1/2
          this.im = [0, 0, 1, 2, 0, 0, 1, 2][y];
          this.cycles += 8; return;
        }
        if (z === 7) {
          switch (y) {
            case 0: this.i = this.a; this.cycles += 9; return; // LD I,A
            case 1: this.r = this.a; this.cycles += 9; return; // LD R,A
            case 2: { // LD A,I
              this.a = this.i;
              let f = (this.f & FLAG_C) | (this.iff2 ? FLAG_PV : 0);
              if (this.a & 0x80) f |= FLAG_S;
              if (this.a === 0) f |= FLAG_Z;
              f |= this.a & (FLAG_X | FLAG_Y);
              this.f = f;
              this.cycles += 9; return;
            }
            case 3: { // LD A,R
              this.a = this.r;
              let f = (this.f & FLAG_C) | (this.iff2 ? FLAG_PV : 0);
              if (this.a & 0x80) f |= FLAG_S;
              if (this.a === 0) f |= FLAG_Z;
              f |= this.a & (FLAG_X | FLAG_Y);
              this.f = f;
              this.cycles += 9; return;
            }
            case 4: { // RRD
              const mem = this._rd(this.hl);
              const newMem = ((this.a & 0xf) << 4) | (mem >>> 4);
              const newA = (this.a & 0xf0) | (mem & 0xf);
              this._wr(this.hl, newMem);
              this.a = newA;
              this._logic8(this.a, false); this.f &= ~FLAG_N; this.f &= ~FLAG_H;
              this.cycles += 18; return;
            }
            case 5: { // RLD
              const mem = this._rd(this.hl);
              const newMem = ((mem << 4) & 0xf0) | (this.a & 0xf);
              const newA = (this.a & 0xf0) | (mem >>> 4);
              this._wr(this.hl, newMem);
              this.a = newA;
              this._logic8(this.a, false); this.f &= ~FLAG_N; this.f &= ~FLAG_H;
              this.cycles += 18; return;
            }
            case 6: case 7: this.cycles += 9; return; // NOP (undocumented ED NOPs)
          }
          return;
        }
      }
      if (x === 2 && z <= 3 && y >= 4) { // block group LDI/LDD/LDIR/LDDR/CPI/CPD/CPIR/CPDR/INI/IND/INIR/INDR/OUTI/OUTD/OTIR/OTDR
        this._execBlockOp(y, z);
        return;
      }
      // everything else in the ED table is an undocumented NOP-equivalent
      this.cycles += 8;
    }

    _execBlockOp(y, z) {
      const inc = (y & 1) === 0 ? 1 : -1; // y even = increment (I), odd = decrement (D)
      const repeat = y >= 6; // IR/DR forms
      if (z === 0) { // LDI/LDD/LDIR/LDDR
        const val = this._rd(this.hl);
        this._wr(this.de, val);
        this.hl = u16(this.hl + inc);
        this.de = u16(this.de + inc);
        this.bc = u16(this.bc - 1);
        let f = this.f & (FLAG_S | FLAG_Z | FLAG_C);
        const n = (val + this.a) & 0xff;
        if (n & 0x02) f |= FLAG_Y;
        if (n & 0x08) f |= FLAG_X;
        if (this.bc !== 0) f |= FLAG_PV;
        this.f = f;
        this.cycles += 16;
        if (repeat && this.bc !== 0) { this.pc = u16(this.pc - 2); this.cycles += 5; }
        return;
      }
      if (z === 1) { // CPI/CPD/CPIR/CPDR
        const val = this._rd(this.hl);
        const result = (this.a - val) & 0xff;
        this.hl = u16(this.hl + inc);
        this.bc = u16(this.bc - 1);
        let f = (this.f & FLAG_C) | FLAG_N;
        if (result & 0x80) f |= FLAG_S;
        if (result === 0) f |= FLAG_Z;
        if (((this.a & 0xf) - (val & 0xf)) & 0x10) f |= FLAG_H;
        if (this.bc !== 0) f |= FLAG_PV;
        const n = result - ((f & FLAG_H) ? 1 : 0);
        if (n & 0x02) f |= FLAG_Y;
        if (n & 0x08) f |= FLAG_X;
        this.f = f;
        this.cycles += 16;
        if (repeat && this.bc !== 0 && result !== 0) { this.pc = u16(this.pc - 2); this.cycles += 5; }
        return;
      }
      if (z === 2) { // INI/IND/INIR/INDR
        const val = (this.bus.ioIn ? this.bus.ioIn(this.c) : 0xff) & 0xff;
        this._wr(this.hl, val);
        this.hl = u16(this.hl + inc);
        this.b = (this.b - 1) & 0xff;
        let f = this.b === 0 ? FLAG_Z : 0;
        f |= FLAG_N;
        this.f = f;
        this.cycles += 16;
        if (repeat && this.b !== 0) { this.pc = u16(this.pc - 2); this.cycles += 5; }
        return;
      }
      if (z === 3) { // OUTI/OUTD/OTIR/OTDR
        const val = this._rd(this.hl);
        if (this.bus.ioOut) this.bus.ioOut(this.c, val);
        this.hl = u16(this.hl + inc);
        this.b = (this.b - 1) & 0xff;
        let f = this.b === 0 ? FLAG_Z : 0;
        f |= FLAG_N;
        this.f = f;
        this.cycles += 16;
        if (repeat && this.b !== 0) { this.pc = u16(this.pc - 2); this.cycles += 5; }
        return;
      }
    }
  }

  // Hand-assembled smoke check: a handful of representative instructions across the major
  // categories (8/16-bit load, arithmetic, flags, jump/call/ret, exchange). Mirrors
  // Arm7Cpu's selfTest() pattern (gsf_emulator.js) — first target for test/smoke.js.
  function selfTest() {
    const mem = new Uint8Array(0x10000);
    const bus = {
      read8: (a) => mem[a & 0xffff],
      write8: (a, v) => { mem[a & 0xffff] = v & 0xff; },
    };
    const cpu = new Z80Cpu(bus);
    cpu.pc = 0x0000;
    // LD A,0x42 ; LD B,0x01 ; ADD A,B ; LD (0x8000),A ; LD HL,0x8000 ; LD C,(HL) ; HALT
    const prog = [
      0x3e, 0x42,       // LD A,0x42
      0x06, 0x01,       // LD B,0x01
      0x80,             // ADD A,B
      0x32, 0x00, 0x80, // LD (0x8000),A
      0x21, 0x00, 0x80, // LD HL,0x8000
      0x4e,             // LD C,(HL)
      0x76,             // HALT
    ];
    mem.set(prog, 0);
    for (let i = 0; i < 200 && !cpu.halted; i++) cpu.step();
    return { a: cpu.a, b: cpu.b, c: cpu.c, mem8000: mem[0x8000], halted: cpu.halted };
  }

  window.Z80Emulator = { Z80Cpu, selfTest };
})();
