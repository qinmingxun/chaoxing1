/**
 * 职责：[SECTION:LIB_MD5] 提供纯原生 JavaScript 的 MD5 字符串摘要函数。
 * 输入按 UTF-8 编码，输出固定为 32 位小写十六进制字符串；同时兼容浏览器全局调用和 Node.js require。
 */
(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module !== null && module.exports) {
    var exportedMd5 = factory();
    module.exports = exportedMd5;
    // 同时提供命名导出，便于后续代码使用 require(...).md5。
    module.exports.md5 = exportedMd5;
    module.exports.default = exportedMd5;
  } else {
    root.md5 = factory();
  }
}(typeof globalThis === "object" ? globalThis :
  (typeof self === "object" ? self : this), function () {
  "use strict";

  var HEX = "0123456789abcdef";
  var SHIFT_F = [7, 12, 17, 22];
  var SHIFT_G = [5, 9, 14, 20];
  var SHIFT_H = [4, 11, 16, 23];
  var SHIFT_I = [6, 10, 15, 21];

  var CONSTANT_F = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821
  ];
  var CONSTANT_G = [
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a
  ];
  var CONSTANT_H = [
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665
  ];
  var CONSTANT_I = [
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  function add32(left, right) {
    return (left + right) >>> 0;
  }

  function rotateLeft(value, amount) {
    return ((value << amount) | (value >>> (32 - amount))) >>> 0;
  }

  function roundF(a, b, c, d, word, shift, constant) {
    var value = (b & c) | (~b & d);
    value = add32(a, value);
    value = add32(value, word);
    value = add32(value, constant);
    return add32(rotateLeft(value, shift), b);
  }

  function roundG(a, b, c, d, word, shift, constant) {
    var value = (b & d) | (c & ~d);
    value = add32(a, value);
    value = add32(value, word);
    value = add32(value, constant);
    return add32(rotateLeft(value, shift), b);
  }

  function roundH(a, b, c, d, word, shift, constant) {
    var value = b ^ c ^ d;
    value = add32(a, value);
    value = add32(value, word);
    value = add32(value, constant);
    return add32(rotateLeft(value, shift), b);
  }

  function roundI(a, b, c, d, word, shift, constant) {
    var value = c ^ (b | ~d);
    value = add32(a, value);
    value = add32(value, word);
    value = add32(value, constant);
    return add32(rotateLeft(value, shift), b);
  }

  // 手动 UTF-8 编码，避免依赖 TextEncoder，使浏览器脚本和 Node 行为一致。
  function encodeUtf8(input) {
    var bytes = [];
    var length = input.length;
    var index;
    var code;
    var next;

    for (index = 0; index < length; index += 1) {
      code = input.charCodeAt(index);

      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 < length) {
          next = input.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            index += 1;
          } else {
            code = 0xfffd;
          }
        } else {
          code = 0xfffd;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        code = 0xfffd;
      }

      if (code <= 0x7f) {
        bytes.push(code);
      } else if (code <= 0x7ff) {
        bytes.push(0xc0 | (code >>> 6));
        bytes.push(0x80 | (code & 0x3f));
      } else if (code <= 0xffff) {
        bytes.push(0xe0 | (code >>> 12));
        bytes.push(0x80 | ((code >>> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      } else {
        bytes.push(0xf0 | (code >>> 18));
        bytes.push(0x80 | ((code >>> 12) & 0x3f));
        bytes.push(0x80 | ((code >>> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      }
    }

    return bytes;
  }

  function toHexLittleEndian(word) {
    var output = "";
    var byte;
    var index;

    for (index = 0; index < 4; index += 1) {
      byte = (word >>> (index * 8)) & 0xff;
      output += HEX.charAt(byte >>> 4) + HEX.charAt(byte & 0x0f);
    }
    return output;
  }

  function md5(input) {
    var bytes;
    var byteLength;
    var paddedLength;
    var message;
    var bitLengthLow;
    var bitLengthHigh;
    var offset;
    var index;
    var wordIndex;
    var words;
    var a;
    var b;
    var c;
    var d;
    var oldA;
    var oldB;
    var oldC;
    var oldD;
    var stateA = 0x67452301;
    var stateB = 0xefcdab89;
    var stateC = 0x98badcfe;
    var stateD = 0x10325476;
    var word;

    if (typeof input !== "string") {
      throw new TypeError("md5 expects a string");
    }

    bytes = encodeUtf8(input);
    byteLength = bytes.length;
    // 0x80 以及 8 字节长度字段需要额外的 9 字节空间。
    paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
    message = new Uint8Array(paddedLength);

    for (index = 0; index < byteLength; index += 1) {
      message[index] = bytes[index];
    }
    message[byteLength] = 0x80;

    // 长度字段按 little-endian 写入；高 32 位等于 floor(bytes / 2^29)。
    bitLengthLow = (byteLength * 8) >>> 0;
    bitLengthHigh = Math.floor(byteLength / 0x20000000) >>> 0;
    for (index = 0; index < 4; index += 1) {
      message[paddedLength - 8 + index] = (bitLengthLow >>> (index * 8)) & 0xff;
      message[paddedLength - 4 + index] = (bitLengthHigh >>> (index * 8)) & 0xff;
    }

    words = new Uint32Array(16);
    for (offset = 0; offset < paddedLength; offset += 64) {
      for (wordIndex = 0; wordIndex < 16; wordIndex += 1) {
        index = offset + wordIndex * 4;
        words[wordIndex] = (
          message[index] |
          (message[index + 1] << 8) |
          (message[index + 2] << 16) |
          (message[index + 3] << 24)
        ) >>> 0;
      }

      a = stateA;
      b = stateB;
      c = stateC;
      d = stateD;

      for (wordIndex = 0; wordIndex < 16; wordIndex += 1) {
        oldA = a;
        oldB = b;
        oldC = c;
        oldD = d;
        a = roundF(oldA, oldB, oldC, oldD, words[wordIndex],
          SHIFT_F[wordIndex & 3], CONSTANT_F[wordIndex]);
        d = oldD;
        c = oldC;
        b = oldB;
        // Rotate the four working registers for the next MD5 operation.
        oldA = a;
        a = d;
        d = c;
        c = b;
        b = oldA;
      }
      for (wordIndex = 0; wordIndex < 16; wordIndex += 1) {
        oldA = a;
        oldB = b;
        oldC = c;
        oldD = d;
        word = words[(wordIndex * 5 + 1) & 15];
        a = roundG(oldA, oldB, oldC, oldD, word,
          SHIFT_G[wordIndex & 3], CONSTANT_G[wordIndex]);
        d = oldD;
        c = oldC;
        b = oldB;
        oldA = a;
        a = d;
        d = c;
        c = b;
        b = oldA;
      }
      for (wordIndex = 0; wordIndex < 16; wordIndex += 1) {
        oldA = a;
        oldB = b;
        oldC = c;
        oldD = d;
        word = words[(wordIndex * 3 + 5) & 15];
        a = roundH(oldA, oldB, oldC, oldD, word,
          SHIFT_H[wordIndex & 3], CONSTANT_H[wordIndex]);
        d = oldD;
        c = oldC;
        b = oldB;
        oldA = a;
        a = d;
        d = c;
        c = b;
        b = oldA;
      }
      for (wordIndex = 0; wordIndex < 16; wordIndex += 1) {
        oldA = a;
        oldB = b;
        oldC = c;
        oldD = d;
        word = words[(wordIndex * 7) & 15];
        a = roundI(oldA, oldB, oldC, oldD, word,
          SHIFT_I[wordIndex & 3], CONSTANT_I[wordIndex]);
        d = oldD;
        c = oldC;
        b = oldB;
        oldA = a;
        a = d;
        d = c;
        c = b;
        b = oldA;
      }

      stateA = add32(stateA, a);
      stateB = add32(stateB, b);
      stateC = add32(stateC, c);
      stateD = add32(stateD, d);
    }

    return toHexLittleEndian(stateA) + toHexLittleEndian(stateB) +
      toHexLittleEndian(stateC) + toHexLittleEndian(stateD);
  }

  return md5;
}));
