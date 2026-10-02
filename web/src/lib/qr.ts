/**
 * A minimal QR Code encoder — byte mode, error-correction level M, versions
 * 1–10 (up to 216 data codewords, far more than any site URL needs).
 *
 * Why hand-written instead of a dependency: this frontend ships exactly two
 * runtime packages (react, react-dom), and the share card only ever encodes one
 * short, same-origin URL. A full QR library would be by far the largest thing in
 * the bundle for a single fixed-shape string.
 *
 * `encodeQr` is a pure function returning the module matrix, so the whole
 * encoder is unit-testable in Node with no canvas and no DOM — the same
 * arrangement `download.ts` and `outcome.ts` already use.
 */

/** Error-correction level M, whose 2-bit format field is 00. */
const FORMAT_BITS_M = 0;

/** Per-version block layout for level M: [ec codewords per block, [block, data codewords]...]. */
const VERSIONS_M: Array<{ ecPerBlock: number; groups: Array<[blocks: number, dataCodewords: number]> }> = [
  { ecPerBlock: 10, groups: [[1, 16]] }, // 1
  { ecPerBlock: 16, groups: [[1, 28]] }, // 2
  { ecPerBlock: 26, groups: [[1, 44]] }, // 3
  { ecPerBlock: 18, groups: [[2, 32]] }, // 4
  { ecPerBlock: 24, groups: [[2, 43]] }, // 5
  { ecPerBlock: 16, groups: [[4, 27]] }, // 6
  { ecPerBlock: 18, groups: [[4, 31]] }, // 7
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] }, // 8
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] }, // 9
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }, // 10
];

export const MAX_QR_VERSION = VERSIONS_M.length;

// ---------------------------------------------------------------- GF(256) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial for QR's GF(256)
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords, highest power first. */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder of `data` modulo the generator polynomial. */
function rsEncode(data: number[], ecLength: number): number[] {
  const gen = rsGeneratorPoly(ecLength);
  const remainder = new Array<number>(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return remainder;
}

// --------------------------------------------------------------- encoding ----

function totalDataCodewords(version: number): number {
  const spec = VERSIONS_M[version - 1];
  return spec.groups.reduce((sum, [blocks, dataCodewords]) => sum + blocks * dataCodewords, 0);
}

function utf8Bytes(text: string): number[] {
  const encoded = new TextEncoder().encode(text);
  return Array.from(encoded);
}

/** Smallest version whose data capacity holds `byteLength` payload bytes. */
export function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_QR_VERSION; version++) {
    // 4-bit mode indicator + 8- or 16-bit character count, then the payload.
    const countBits = version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= totalDataCodewords(version) * 8) return version;
  }
  throw new Error(
    `That link is too long to encode as a QR code (${byteLength} bytes). Use a shorter site URL.`,
  );
}

/** Mode indicator + character count + payload + terminator + padding. */
function buildDataCodewords(bytes: number[], version: number): number[] {
  const capacityBits = totalDataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a byte boundary, then alternating pad codewords.
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < capacityBits / 8; i++) codewords.push(pads[i % 2]);
  return codewords;
}

/** Split into blocks, add error correction, then interleave per the standard. */
function buildFinalCodewords(dataCodewords: number[], version: number): number[] {
  const spec = VERSIONS_M[version - 1];
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (const [blocks, groupDataCodewords] of spec.groups) {
    for (let b = 0; b < blocks; b++) {
      const block = dataCodewords.slice(offset, offset + groupDataCodewords);
      offset += groupDataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ecPerBlock));
    }
  }

  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------- matrix -----

interface Grid {
  size: number;
  modules: boolean[][];
  /** Function modules (finders, timing, format…) that data must not overwrite. */
  reserved: boolean[][];
}

function createGrid(version: number): Grid {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const grid: Grid = { size, modules, reserved };

  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns plus their separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as Array<[number, number]>) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  // Alignment patterns, skipping the three finder corners.
  for (const x of alignmentPositions(version)) {
    for (const y of alignmentPositions(version)) {
      const nearFinder =
        (x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Version information (versions 7 and up).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  return grid;
}

/** Alignment-pattern centre coordinates for a version. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const result = new Array<number>(count).fill(6);
  for (let i = count - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

/** Walk the zig-zag pattern, skipping function modules and remainder bits. */
function drawCodewords(grid: Grid, codewords: number[]): void {
  const { size, modules, reserved } = grid;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern is not a data column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && bitIndex < totalBits) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
        // Any remainder bits stay light, as the standard requires.
      }
    }
  }
}

/** Whether mask `mask` inverts the module at column x, row y. */
function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error(`Unknown mask ${mask}`);
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (grid.reserved[y][x]) continue;
      if (maskApplies(mask, x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

/** Write both copies of the 15-bit format information. */
function drawFormatBits(grid: Grid, mask: number): void {
  const { size, modules, reserved } = grid;
  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  const getBit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
  setFunction(8, 7, getBit(bits, 6));
  setFunction(8, 8, getBit(bits, 7));
  setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
  setFunction(size - 8, 8, true); // the always-dark module
}

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** Standard penalty score; the mask with the lowest score is used. */
function penaltyScore(modules: boolean[][], size: number): number {
  let score = 0;

  const scoreLine = (get: (i: number) => boolean) => {
    let runLength = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        runLength++;
        if (runLength === 5) score += PENALTY_RUN;
        else if (runLength > 5) score += 1;
      } else {
        runLength = 1;
      }
    }
    // Finder-like patterns: 1011101 0000 or 0000 1011101.
    for (let i = 0; i + 11 <= size; i++) {
      const pattern = Array.from({ length: 11 }, (_, k) => get(i + k));
      const a = [true, false, true, true, true, false, true, false, false, false, false];
      const b = [false, false, false, false, true, false, true, true, true, false, true];
      if (pattern.every((v, k) => v === a[k]) || pattern.every((v, k) => v === b[k])) {
        score += PENALTY_FINDER;
      }
    }
  };

  for (let y = 0; y < size; y++) scoreLine((x) => modules[y][x]);
  for (let x = 0; x < size; x++) scoreLine((y) => modules[y][x]);

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
        score += PENALTY_BLOCK;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const color of row) if (color) dark++;
  const total = size * size;
  const k = Math.floor(Math.abs((dark * 20) - (total * 10)) / total);
  score += k * PENALTY_BALANCE;

  return score;
}

export interface QrCode {
  /** Modules per side (21 for version 1, 57 for version 10). */
  size: number;
  /** `matrix[row][column]` — true means a dark module. */
  matrix: boolean[][];
  version: number;
}

/**
 * Encode `text` (byte mode, level M) and return its module matrix.
 * Throws when the text cannot fit in version 10.
 */
export function encodeQr(text: string): QrCode {
  if (text.length === 0) throw new Error("Nothing to encode.");
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length);
  const codewords = buildFinalCodewords(buildDataCodewords(bytes, version), version);

  // Build the un-masked grid once, then try every mask on a copy.
  const base = createGrid(version);
  // Reserve the format-information cells with a placeholder mask *before* data
  // placement. Without this the zig-zag walk would write data bits into them and
  // `drawFormatBits` would then silently overwrite that data.
  drawFormatBits(base, 0);
  drawCodewords(base, codewords);

  let best: { mask: number; modules: boolean[][] } | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate: Grid = {
      size: base.size,
      modules: base.modules.map((row) => row.slice()),
      reserved: base.reserved.map((row) => row.slice()),
    };
    applyMask(candidate, mask);
    drawFormatBits(candidate, mask);
    const score = penaltyScore(candidate.modules, candidate.size);
    if (score < bestScore) {
      bestScore = score;
      best = { mask, modules: candidate.modules };
    }
  }

  if (!best) throw new Error("QR encoding failed.");
  return { size: base.size, matrix: best.modules, version };
}
