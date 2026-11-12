/* Experimental Code 128 reader. No external decoder is called by this module.
 * Pattern-table data adapted from ZXing-C++ ODCode128Patterns.h:
 * Copyright 2016 Nu-book Inc.; Copyright 2016 ZXing authors. Apache-2.0.
 * See engine/THIRD-PARTY.txt and vendor/ZXING-CPP-LICENSE.txt.
 * Matching, validation, scan sampling and consensus logic are project code.
 */
(function (root) {
  'use strict';
  const patterns = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ].map((pattern) => Array.from(pattern, Number));
  const identity = (result) => JSON.stringify([result.bytes, result.gs1]);

  function validatePixels(gray, width, height) {
    if (!(gray instanceof Uint8Array) && !(gray instanceof Uint8ClampedArray)) {
      throw new Error('Code128 requires unsigned grayscale bytes.');
    }
    if (
        !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > 8192 || width * height > 4_000_000 || gray.length !== width * height) {
      throw new Error('Code128 requires a grayscale byte array of valid dimensions (maximum 4 megapixels, width 8192).');
    }
  }

  function thresholds(gray) {
    const histogram = new Uint32Array(256);
    let low = 255, high = 0, total = 0;
    for (const value of gray) { histogram[value]++; low = Math.min(low, value); high = Math.max(high, value); total += value; }
    if (high - low < 12) return [];
    let count = 0, sum = 0, bestVariance = -1, threshold = low;
    for (let value = low; value < high; value++) {
      count += histogram[value]; sum += value * histogram[value];
      if (!count || count === gray.length) continue;
      const meanDifference = sum / count - (total - sum) / (gray.length - count);
      const variance = count * (gray.length - count) * meanDifference * meanDifference;
      if (variance > bestVariance) { bestVariance = variance; threshold = value; }
    }
    return [...new Set([threshold, Math.floor((low + high) / 2)])];
  }

  function runsFor(gray, threshold, reverse, invert) {
    const runs = [];
    for (let x = 0; x < gray.length; x++) {
      const value = gray[reverse ? gray.length - 1 - x : x];
      const dark = invert ? value > threshold : value <= threshold;
      const previous = runs[runs.length - 1];
      if (previous && previous.dark === dark) previous.length++;
      else runs.push({ dark, length: 1, start: x });
    }
    return runs;
  }

  function localThreshold(gray, radius) {
    const prefix = new Float64Array(gray.length + 1), binary = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) prefix[i + 1] = prefix[i] + gray[i];
    for (let i = 0; i < gray.length; i++) {
      const left = Math.max(0, i - radius), right = Math.min(gray.length, i + radius + 1);
      binary[i] = gray[i] < (prefix[right] - prefix[left]) / (right - left) - 2 ? 0 : 255;
    }
    return binary;
  }

  function hasSourceQuietZones(gray, result) {
    const mean = (from, to) => {
      const left = Math.max(0, Math.floor(from)), right = Math.min(gray.length, Math.ceil(to));
      if (right <= left) return NaN;
      let sum = 0; for (let i = left; i < right; i++) sum += gray[i];
      return sum / (right - left);
    };
    // Adaptive thresholding must not turn a dark obstruction into a false blank
    // border. Compare both claimed quiet regions with the real adjacent bars.
    const leftContrast = mean(result.left - result.quietLeft, result.left) - mean(result.left, result.left + result.quietLeft / 5);
    const rightContrast = mean(result.right, result.right + result.quietRight) - mean(result.right - result.quietRight / 5, result.right);
    const sign = result.inverted ? -1 : 1;
    return leftContrast * sign >= 3 && rightContrast * sign >= 3;
  }

  function patternError(runs, offset, pattern, count = pattern.length) {
    if (offset + count > runs.length) return null;
    let pixels = 0, modules = 0;
    for (let i = 0; i < count; i++) { pixels += runs[offset + i].length; modules += pattern[i]; }
    const unit = pixels / modules;
    if (unit < 0.8) return null;
    let squared = 0;
    for (let i = 0; i < count; i++) {
      const difference = runs[offset + i].length / unit - pattern[i];
      if (Math.abs(difference) > 0.8) return null;
      squared += difference * difference;
    }
    const error = squared / count;
    return error <= 0.16 ? { error, unit } : null;
  }

  function matchWord(runs, offset, startOnly = false) {
    let best = null, runnerUp = Infinity;
    for (let code = startOnly ? 103 : 0; code <= (startOnly ? 105 : 106); code++) {
      const fit = patternError(runs, offset, patterns[code], 6);
      if (!fit) continue;
      if (!best || fit.error < best.error) { runnerUp = best?.error ?? Infinity; best = { code, ...fit }; }
      else runnerUp = Math.min(runnerUp, fit.error);
    }
    // Ambiguous geometric matches are rejected rather than repaired by guessing.
    return best && runnerUp - best.error >= 0.018 ? best : null;
  }

  function payloadFor(words) {
    let sum = words[0];
    for (let i = 1; i < words.length - 1; i++) sum += i * words[i];
    if (words.length < 3 || sum % 103 !== words[words.length - 1]) return null;
    let set = words[0] - 103, gs1 = false;
    const bytes = [];
    for (let i = 1; i < words.length - 1; i++) {
      const code = words[i];
      if (code === 102) {
        if (i === 1) gs1 = true;
        else {
          // AIM FNC1-in-second-position has different transmission semantics.
          // It is deliberately unsupported in this first GS1-focused prototype.
          if (!gs1 && i === 2 && (set === 2 || (bytes.length === 1 && ((bytes[0] >= 65 && bytes[0] <= 90) || (bytes[0] >= 97 && bytes[0] <= 122))))) return null;
          bytes.push(29);
        }
        continue;
      }
      if (set === 2) {
        if (code < 100) { bytes.push(48 + Math.floor(code / 10), 48 + code % 10); continue; }
        if (code === 100 || code === 101) { set = code === 100 ? 1 : 0; continue; }
        return null;
      }
      if (code < 96) { bytes.push(set === 0 && code >= 64 ? code - 64 : code + 32); continue; }
      if (code === 98) {
        if (++i >= words.length - 1 || words[i] >= 96) return null;
        const shifted = words[i], alternate = 1 - set;
        bytes.push(alternate === 0 && shifted >= 64 ? shifted - 64 : shifted + 32);
      } else if (code === 99) set = 2;
      else if ((set === 0 && code === 100) || (set === 1 && code === 101)) set = 1 - set;
      else return null; // FNC2, FNC3 and extended-byte FNC4 are unsupported.
    }
    return bytes.length ? { bytes, gs1, text: String.fromCharCode(...bytes) } : null;
  }

  function decodeRuns(runs) {
    const results = [];
    for (let offset = 1; offset + 24 <= runs.length; offset++) {
      if (!runs[offset].dark || runs[offset - 1].dark) continue;
      const start = matchWord(runs, offset, true);
      if (!start || runs[offset - 1].length + 0.75 < 10 * start.unit) continue;
      const words = [start.code];
      let unit = start.unit, error = start.error;
      for (let next = offset + 6; next + 6 < runs.length && words.length <= 256; next += 6) {
        const word = matchWord(runs, next);
        if (!word || word.unit / unit < 0.65 || word.unit / unit > 1.5) break;
        if (word.code === 106) {
          const stop = patternError(runs, next, patterns[106]);
          const quiet = runs[next + 7];
          if (!stop || !quiet || quiet.dark || quiet.length + 0.75 < 10 * stop.unit) break;
          const payload = payloadFor(words);
          if (payload) results.push({ ...payload, codewords: [...words, 106], left: runs[offset].start,
            right: runs[next + 6].start + runs[next + 6].length,
            quietLeft: 10 * start.unit, quietRight: 10 * stop.unit,
            meanPatternError: (error + stop.error) / (words.length + 1) });
          break;
        }
        if (word.code >= 103) break;
        words.push(word.code); error += word.error; unit = 0.8 * unit + 0.2 * word.unit;
      }
    }
    return results;
  }

  function decodeScanline(gray, options = {}) {
    validatePixels(gray, gray.length, 1);
    const found = new Map();
    for (const threshold of thresholds(gray)) {
      for (const reverse of [false, true]) {
        for (const invert of options.tryInvert === false ? [false] : [false, true]) {
          for (const result of decodeRuns(runsFor(gray, threshold, reverse, invert))) {
            if (reverse) {
              [result.left, result.right] = [gray.length - result.right, gray.length - result.left];
              [result.quietLeft, result.quietRight] = [result.quietRight, result.quietLeft];
            }
            const key = identity(result);
            const previous = found.get(key);
            if (!previous || result.meanPatternError < previous.meanPatternError) found.set(key, { ...result, reversed: reverse, inverted: invert });
          }
        }
      }
    }
    if (!found.size && options.tryLocalThreshold !== false) {
      // Global thresholds can lose one end of a shaded label. Two fixed local
      // scales provide bounded retries; all symbol, checksum and border tests
      // still run, and different plausible values remain ambiguous.
      for (const radius of [8, 32]) {
        const result = decodeScanline(localThreshold(gray, radius), { ...options, tryLocalThreshold: false });
        if (result && hasSourceQuietZones(gray, result)) found.set(identity(result), { ...result, thresholdMethod: `local-mean-${radius}` });
      }
    }
    if (found.size !== 1) return null;
    const result = found.values().next().value;
    return { ...result, format: 'Code128', lineCount: 1, position: {
      topLeft: { x: result.left, y: 0 }, topRight: { x: result.right, y: 0 },
      bottomRight: { x: result.right, y: 0 }, bottomLeft: { x: result.left, y: 0 },
    } };
  }

  function decodeRows(gray, width, height, options = {}) {
    validatePixels(gray, width, height);
    if (height < 2) return null;
    const maximum = Math.min(height, 31, Math.max(2, Math.floor(options.maxRows ?? 15)));
    const rows = new Set();
    for (let i = 0; i < maximum; i++) rows.add(Math.min(height - 1, Math.floor(height * (i + 0.5) / maximum)));
    const groups = new Map();
    for (const y of rows) {
      const result = decodeScanline(gray.subarray(y * width, (y + 1) * width), options);
      if (!result) continue;
      const key = identity(result);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ result, y });
    }
    const minimum = Math.max(2, Math.min(31, Math.floor(options.minLineCount ?? 2)));
    const eligible = [...groups.values()].filter((group) => group.length >= minimum);
    // A candidate crop containing competing valid values needs a tighter detector crop.
    if (eligible.length !== 1) return null;
    const group = eligible[0], best = group.reduce((a, b) => a.result.meanPatternError <= b.result.meanPatternError ? a : b);
    const left = Math.min(...group.map((item) => item.result.left)), right = Math.max(...group.map((item) => item.result.right));
    const top = Math.min(...group.map((item) => item.y)), bottom = Math.max(...group.map((item) => item.y));
    const result = { ...best.result, lineCount: group.length,
      quietLeft: Math.max(...group.map((item) => item.result.quietLeft)),
      quietRight: Math.max(...group.map((item) => item.result.quietRight)), position: {
      topLeft: { x: left, y: top }, topRight: { x: right, y: top },
      bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom },
    } };
    return result;
  }

  const api = { decodeScanline, decodeRows, version: '0.1.0-experimental' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Code128Decoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
