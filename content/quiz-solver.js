/**
 * Course Helper quiz solver core。
 * 职责：提供题型映射、题干/选项清洗、答案比较、填空数量推断、
 *       DeepSeek 请求数据构造和学习通缓存 key 计算；本文件的核心区块不依赖 DOM。
 * [SECTION:QUIZ_SOLVER]
 */
(function installQuizSolver(globalRoot, importedMd5) {
  'use strict';

  var api = (function createQuizCore() {
    'use strict';

    // ==== SECTION: quiz-core ====

    var QUESTION_TYPES = Object.freeze({
      SINGLE: 0,
      MULTIPLE: 1,
      FILL: 2,
      TRUE_FALSE: 3,
      SHORT_ANSWER: 4,
      SORTABLE: 5,
      SINGLE_CHOICE: 0,
      MULTIPLE_CHOICE: 1,
      FILL_BLANK: 2,
      JUDGMENT: 3,
      SHORT: 4,
      DRAG_DROP: 5
    });

    var QUESTION_TYPE_MAP = Object.freeze({
      '0': 0,
      '1': 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '单选': 0,
      '单选题': 0,
      '单项选择': 0,
      '单项选择题': 0,
      'single': 0,
      'singlechoice': 0,
      'single-choice': 0,
      'multiple': 1,
      'multiplechoice': 1,
      'multiple-choice': 1,
      '多选': 1,
      '多选题': 1,
      '多项选择': 1,
      '多项选择题': 1,
      'fill': 2,
      'fillblank': 2,
      'fill-blank': 2,
      'blank': 2,
      '填空': 2,
      '填空题': 2,
      'truefalse': 3,
      'true-false': 3,
      'judgment': 3,
      'judge': 3,
      '判断': 3,
      '判断题': 3,
      'short': 4,
      'shortanswer': 4,
      'short-answer': 4,
      'essay': 4,
      '简答': 4,
      '简答题': 4,
      '问答': 4,
      '问答题': 4,
      'sortable': 5,
      'dragdrop': 5,
      'drag-drop': 5,
      '排序': 5,
      '拖拽': 5,
      '拖拽排序': 5,
      'drag': 5,
      'drop': 5
    });

    var QUESTION_TYPE_WORDS = '(?:单项选择题?|单选题?|多项选择题?|多选题?|填空题?|判断题?|简答题?|问答题?|single\\s*choice|multiple\\s*choice|fill\\s*(?:in\\s*)?the\\s*blank|true\\s*/?\\s*false|short\\s*answer|essay|排序题|拖拽题|拖拽排序|drag\\s*(?:and\\s*)?drop|sortable)';
    var QUESTION_TYPE_PREFIX_RE = new RegExp(
      '^\\s*(?:(?:【|\\[|（|\\()\\s*' + QUESTION_TYPE_WORDS +
        '\\s*(?:】|\\]|）|\\))|(?:' + QUESTION_TYPE_WORDS + ')\\s*[:：])\\s*',
      'i'
    );
    var SCORE_RE = /[（(【\[]\s*\d+(?:\.\d+)?\s*分\s*[）)】\]]/g;
    var QUESTION_NUMBER_PREFIX_RE = /^\s*(?:(?:第\s*\d+\s*题)|(?:题号\s*[:：]?\s*\d+)|(?:[（(【\[]\s*\d+\s*[）)】\]])|(?:\d+\s*[.．、:：)]))\s*/;
    var OPTION_PREFIX_RE = /^\s*(?:[（(]\s*[A-Za-zＡ-Ｚａ-ｚ]\s*[）)]|[A-Za-zＡ-Ｚａ-ｚ]\s*[.．、,，:：;；)])\s*/;
    var IMAGE_TOKEN_START = '\u0001';
    var IMAGE_TOKEN_END = '\u0002';
    var ENTITY_NAMES = {
      nbsp: ' ',
      ensp: ' ',
      emsp: ' ',
      thinsp: ' ',
      zwnj: '',
      zwj: '',
      shy: '',
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      hellip: '…',
      mdash: '—',
      ndash: '–',
      middot: '·'
    };

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function toText(value) {
      if (value === null || value === undefined) {
        return '';
      }
      return String(value);
    }

    function normalizeUnicode(value) {
      var text = toText(value);
      if (typeof text.normalize === 'function') {
        try {
          return text.normalize('NFKC');
        } catch (ignoredNormalizeError) {
          // Older engines or malformed surrogate sequences can lack NFKC support.
        }
      }
      return text;
    }

    function decodeHtmlEntities(value) {
      var text = toText(value);
      return text.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));/gi,
        function decodeEntity(match, hexadecimal, decimal, named) {
          var codePoint;
          var number;
          if (hexadecimal) {
            number = parseInt(hexadecimal, 16);
            codePoint = number;
          } else if (decimal) {
            number = parseInt(decimal, 10);
            codePoint = number;
          } else {
            var lowerName = String(named).toLowerCase();
            if (Object.prototype.hasOwnProperty.call(ENTITY_NAMES, lowerName)) {
              return ENTITY_NAMES[lowerName];
            }
            return match;
          }
          if (!isFinite(number) || number < 0 || number > 0x10ffff) {
            return match;
          }
          try {
            return String.fromCodePoint(codePoint);
          } catch (ignoredCodePointError) {
            return String.fromCharCode(codePoint <= 0xffff ? codePoint : 0xfffd);
          }
        });
    }

    function normalizeWhitespace(value) {
      return toText(value).replace(/\s+/g, ' ').trim();
    }

    function protectImages(value, images) {
      return toText(value).replace(/<img\b[^>]*>/gi, function keepImage(image) {
        var index = images.length;
        images.push(image);
        return IMAGE_TOKEN_START + 'IMG' + index + IMAGE_TOKEN_END;
      });
    }

    function restoreImages(value, images) {
      return toText(value).replace(/\u0001IMG(\d+)\u0002/g, function restoreImage(match, indexText) {
        var index = Number(indexText);
        return images[index] === undefined ? '' : images[index];
      });
    }

    function stripHtml(value, preserveImages) {
      var images = [];
      var text = toText(value);
      if (preserveImages) {
        text = protectImages(text, images);
      } else {
        text = text.replace(/<img\b[^>]*>/gi, '');
      }

      // Script/style contents are not question text. Block separators retain words
      // that were separated by a visual line break without introducing DOM access.
      text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|header|footer)\s*>/gi, ' ')
        .replace(/<[^>]*>/g, '');

      text = decodeHtmlEntities(text);
      text = normalizeWhitespace(text);
      return preserveImages ? restoreImages(text, images) : text;
    }

    function parseQuestionType(value) {
      var candidate = value;
      if (isRecord(candidate)) {
        if (candidate.qtype !== undefined) {
          candidate = candidate.qtype;
        } else if (candidate.type !== undefined) {
          candidate = candidate.type;
        } else if (candidate.questionType !== undefined) {
          candidate = candidate.questionType;
        } else if (candidate.kind !== undefined) {
          candidate = candidate.kind;
        } else if (candidate.label !== undefined) {
          candidate = candidate.label;
        }
      }

      if (typeof candidate === 'number') {
        return Number.isInteger(candidate) && candidate >= 0 && candidate <= 4 ? candidate : null;
      }

      var text = normalizeUnicode(candidate).trim();
      if (!text) {
        return null;
      }
      if (/^[0-4]$/.test(text)) {
        return Number(text);
      }

      var compact = text.toLowerCase().replace(/[\s_]+/g, '');
      if (Object.prototype.hasOwnProperty.call(QUESTION_TYPE_MAP, compact)) {
        return QUESTION_TYPE_MAP[compact];
      }
      if (/多项?选择|multiple/.test(compact)) {
        return 1;
      }
      if (/单项?选择|single/.test(compact)) {
        return 0;
      }
      if (/填空|blank/.test(compact)) {
        return 2;
      }
      if (/判断|true.*false|false.*true|judg/.test(compact)) {
        return 3;
      }
      if (/简答|问答|short|essay/.test(compact)) {
        return 4;
      }
      return null;
    }

    function cleanOptionHtml(value) {
      var text = stripHtml(value, false);
      text = normalizeUnicode(text);
      // A.、A、（A） and their full-width equivalents are presentation labels,
      // not part of the option answer.
      text = text.replace(OPTION_PREFIX_RE, '');
      return normalizeWhitespace(text);
    }

    function removeQuestionTypePrefix(value) {
      var text = toText(value);
      var previous;
      do {
        previous = text;
        text = text.replace(QUESTION_TYPE_PREFIX_RE, '');
      } while (text !== previous);
      return text;
    }

    function removeQuestionNumberPrefix(value) {
      var text = toText(value);
      var previous;
      do {
        previous = text;
        text = text.replace(QUESTION_NUMBER_PREFIX_RE, '');
      } while (text !== previous);
      return text;
    }

    function cleanStemHtml(value) {
      var text = stripHtml(value, true);
      // Scores can occur before or after the type/number prefix, so remove them
      // before and during the prefix passes.
      text = text.replace(SCORE_RE, '');
      var previous;
      do {
        previous = text;
        text = removeQuestionTypePrefix(text);
        text = removeQuestionNumberPrefix(text);
        text = text.replace(SCORE_RE, '');
      } while (text !== previous);
      return normalizeWhitespace(text);
    }

    function normalizeForCompare(value) {
      var text = normalizeUnicode(value).toUpperCase();
      // Keep Chinese, ASCII letters and digits only. NFKC above makes full-width
      // Latin letters/digits comparable to their ASCII forms.
      return text.replace(/[^0-9A-Z〇㐀-䶿一-鿿豈-﫿]/g, '');
    }

    function asArray(value) {
      if (value === null || value === undefined) {
        return [];
      }
      if (Array.isArray(value)) {
        return value.slice();
      }
      if (typeof value !== 'string' && typeof value.length === 'number') {
        var result = [];
        for (var index = 0; index < value.length; index += 1) {
          result.push(value[index]);
        }
        return result;
      }
      return [value];
    }

    function optionText(option) {
      if (isRecord(option)) {
        if (option.html !== undefined) {
          return cleanOptionHtml(option.html);
        }
        if (option.text !== undefined) {
          return cleanOptionHtml(option.text);
        }
        if (option.label !== undefined) {
          return cleanOptionHtml(option.label);
        }
        if (option.value !== undefined) {
          return cleanOptionHtml(option.value);
        }
      }
      return cleanOptionHtml(option);
    }

    function optionLabel(index) {
      var number = Number(index);
      if (!Number.isInteger(number) || number < 0 || number > 25) {
        return '';
      }
      return String.fromCharCode(65 + number);
    }

    function labelIndex(value, optionCount) {
      var normalized = normalizeForCompare(value);
      if (!/^[A-Z]$/.test(normalized)) {
        var labelMatch = normalized.match(/^(?:选项|答案)?([A-Z])$/);
        if (labelMatch) {
          normalized = labelMatch[1];
        }
      }
      if (!/^[A-Z]$/.test(normalized)) {
        return -1;
      }
      var index = normalized.charCodeAt(0) - 65;
      return index >= 0 && index < optionCount ? index : -1;
    }

    function splitLetterToken(value) {
      var text = normalizeWhitespace(value);
      if (/^[A-Z]{2,26}$/.test(text)) {
        return text.split('');
      }
      return [text];
    }

    function parseMultiAnswer(value) {
      if (Array.isArray(value)) {
        var arrayTokens = [];
        value.forEach(function addArrayToken(item) {
          parseMultiAnswer(item).forEach(function addNestedToken(token) {
            arrayTokens.push(token);
          });
        });
        return uniqueTokens(arrayTokens);
      }

      var text = normalizeUnicode(value).trim();
      if (!text) {
        return [];
      }
      var parts = text.split(/\s*#\s*/);
      var tokens = [];
      parts.forEach(function addPart(part) {
        var candidate = normalizeWhitespace(part)
          .replace(/^[,，、;；|]+|[,，、;；|]+$/g, '')
          .trim();
        if (!candidate) {
          return;
        }
        if (/^[A-Za-z](?:\s*[,，、;；|]\s*[A-Za-z])+$/i.test(candidate)) {
          candidate.split(/\s*[,，、;；|]\s*/).forEach(function addDelimitedLetter(letter) {
            if (letter) {
              tokens.push(letter.toUpperCase());
            }
          });
          return;
        }
        var compact = candidate.replace(/\s+/g, '');
        if (/^[A-Z]{2,26}$/.test(compact)) {
          compact.split('').forEach(function addLetter(letter) {
            tokens.push(letter);
          });
          return;
        }
        if (/^[a-z]{2,26}$/.test(compact)) {
          compact.toUpperCase().split('').forEach(function addLowercaseLetter(letter) {
            tokens.push(letter);
          });
          return;
        }
        if (/^[A-Za-z]$/.test(compact)) {
          tokens.push(compact.toUpperCase());
          return;
        }
        tokens.push(candidate);
      });
      return uniqueTokens(tokens);
    }

    function uniqueTokens(tokens) {
      var result = [];
      var seen = Object.create(null);
      asArray(tokens).forEach(function addUniqueToken(token) {
        var text = normalizeWhitespace(token);
        if (!text) {
          return;
        }
        var key = normalizeForCompare(text);
        if (!key || seen[key]) {
          return;
        }
        seen[key] = true;
        result.push(text);
      });
      return result;
    }

    function bestContainsMatch(token, options) {
      var tokenNormalized = normalizeForCompare(token);
      if (!tokenNormalized) {
        return -1;
      }
      var bestIndex = -1;
      var bestLength = -1;
      options.forEach(function inspectOption(option, index) {
        var optionNormalized = normalizeForCompare(option);
        if (!optionNormalized) {
          return;
        }
        if (tokenNormalized.indexOf(optionNormalized) === -1 &&
            optionNormalized.indexOf(tokenNormalized) === -1) {
          return;
        }
        var candidateLength = optionNormalized.length;
        if (candidateLength > bestLength) {
          bestLength = candidateLength;
          bestIndex = index;
        }
      });
      return bestIndex;
    }

    function findSingleAnswerIndex(answer, options) {
      var optionTexts = options.map(optionText);
      var cleanedAnswer = cleanOptionHtml(answer);
      var answerNormalized = normalizeForCompare(cleanedAnswer);
      if (!answerNormalized) {
        return -1;
      }

      // A/B/C labels are checked before text matching because the option text
      // itself may happen to contain a single Latin letter.
      var indexByLabel = labelIndex(cleanedAnswer, optionTexts.length);
      if (indexByLabel >= 0) {
        return indexByLabel;
      }

      for (var index = 0; index < optionTexts.length; index += 1) {
        if (normalizeForCompare(optionTexts[index]) === answerNormalized) {
          return index;
        }
      }

      return bestContainsMatch(cleanedAnswer, optionTexts);
    }

    function matchAnswerToOptions(answer, options, qtype) {
      var optionList = asArray(options);
      var optionTexts = optionList.map(optionText);
      var type = parseQuestionType(qtype);
      var tokens = type === 1 || toText(answer).indexOf('#') !== -1
        ? parseMultiAnswer(answer)
        : [normalizeWhitespace(answer)];
      var matched = [];
      var seen = Object.create(null);

      tokens.forEach(function matchToken(token) {
        var index = findSingleAnswerIndex(token, optionTexts);
        if (index >= 0 && !seen[index]) {
          seen[index] = true;
          matched.push(index);
        }
      });
      return matched;
    }

    function matchAnswerIndex(answer, options, qtype) {
      var matches = matchAnswerToOptions(answer, options, qtype);
      return matches.length ? matches[0] : -1;
    }

    function identityForInput(value, index) {
      if (isRecord(value)) {
        var name = normalizeWhitespace(value.name);
        var id = normalizeWhitespace(value.id);
        if (name) {
          return 'name:' + name;
        }
        if (id) {
          return 'id:' + id;
        }
        return value;
      }
      var text = normalizeWhitespace(value);
      return text ? 'value:' + text : 'index:' + index;
    }

    function uniqueCount(values, inputMode) {
      var list = asArray(values);
      var seenObjects = typeof WeakSet === 'function' ? new WeakSet() : [];
      var seenKeys = Object.create(null);
      var count = 0;
      list.forEach(function countValue(value, index) {
        if (value === null || value === undefined || value === '') {
          return;
        }
        var key;
        if (inputMode && isRecord(value)) {
          key = identityForInput(value, index);
        } else if (isRecord(value)) {
          var name = normalizeWhitespace(value.name);
          var id = normalizeWhitespace(value.id);
          key = name ? 'name:' + name : (id ? 'id:' + id : value);
        } else {
          key = normalizeWhitespace(value);
        }
        if (typeof key === 'object') {
          if (seenObjects instanceof WeakSet) {
            if (seenObjects.has(key)) {
              return;
            }
            seenObjects.add(key);
          } else if (seenObjects.indexOf(key) !== -1) {
            return;
          } else {
            seenObjects.push(key);
          }
          count += 1;
          return;
        }
        key = String(key);
        if (!key || seenKeys[key]) {
          return;
        }
        seenKeys[key] = true;
        count += 1;
      });
      return count;
    }

    function firstNonEmptyValue(source, keys) {
      for (var index = 0; index < keys.length; index += 1) {
        if (source[keys[index]] !== undefined && source[keys[index]] !== null) {
          var candidate = source[keys[index]];
          if (asArray(candidate).length > 0) {
            return candidate;
          }
        }
      }
      return null;
    }

    function inputCountFromQuestion(source) {
      var inputElements = firstNonEmptyValue(source, [
        'inputs', 'inputElements', 'blankInputs', 'inputFields'
      ]);
      if (inputElements !== null) {
        var count = uniqueCount(inputElements, true);
        if (count > 0) {
          return count;
        }
      }

      var inputNames = firstNonEmptyValue(source, [
        'inputNames', 'blankInputNames', 'names'
      ]);
      var nameCount = uniqueCount(inputNames, false);
      if (nameCount > 0) {
        return nameCount;
      }

      var inputIds = firstNonEmptyValue(source, [
        'inputIds', 'blankInputIds', 'ids'
      ]);
      var idCount = uniqueCount(inputIds, false);
      if (idCount > 0) {
        return idCount;
      }
      return 0;
    }

    function editorCountFromQuestion(source) {
      var indexes = firstNonEmptyValue(source, [
        'editorIndexes', 'dataEditorIndexes', 'editorindices',
        'editorIndex', 'dataEditorIndex'
      ]);
      return uniqueCount(indexes, false);
    }

    function textareaCountFromQuestion(source) {
      var textareas = firstNonEmptyValue(source, [
        'textareas', 'textareaElements', 'blankTextareas', 'textareaNames', 'textareaIds'
      ]);
      var count = uniqueCount(textareas, false);
      if (count > 0) {
        return count;
      }
      var scalarCount = Number(source.textareaCount);
      return Number.isFinite(scalarCount) && scalarCount > 0 ? Math.floor(scalarCount) : 0;
    }

    function countStemBlankMarkers(stem) {
      var text = toText(stem);
      var explicitMatches = text.match(/第\s*\d+\s*空/g);
      if (explicitMatches && explicitMatches.length > 0) {
        return explicitMatches.length;
      }
      var parenthesizedMatches = text.match(/[（(]\s*\d+\s*[）)]/g);
      return parenthesizedMatches ? parenthesizedMatches.length : 0;
    }

    function getBlankCount(questionOrStem, inputs, editorIndexes, textareas) {
      var source;
      if (isRecord(questionOrStem)) {
        source = questionOrStem;
      } else {
        source = {
          stem: questionOrStem,
          inputs: inputs,
          editorIndexes: editorIndexes,
          textareas: textareas
        };
      }

      var count = inputCountFromQuestion(source);
      if (count > 0) {
        return count;
      }
      count = editorCountFromQuestion(source);
      if (count > 0) {
        return count;
      }
      count = textareaCountFromQuestion(source);
      if (count > 0) {
        return count;
      }

      var stem = source.stem !== undefined ? source.stem :
        (source.questionStem !== undefined ? source.questionStem : source.title);
      count = countStemBlankMarkers(stem);
      return count > 0 ? count : 1;
    }

    function normalizeDomain(value) {
      var candidate = value;
      if (isRecord(candidate)) {
        if (candidate.hostname !== undefined) {
          candidate = candidate.hostname;
        } else if (candidate.location !== undefined) {
          candidate = candidate.location;
        } else if (candidate.domain !== undefined) {
          candidate = candidate.domain;
        }
      }
      if (isRecord(candidate)) {
        candidate = candidate.hostname;
      }
      var domain = normalizeUnicode(candidate).trim().toLowerCase();
      if (!domain) {
        throw new TypeError('domain must be a non-empty hostname');
      }
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(domain)) {
        var authority = domain.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
        domain = authority;
      } else {
        domain = domain.split(/[/?#]/, 1)[0];
      }
      if (domain.charAt(0) === '[' && domain.charAt(domain.length - 1) === ']') {
        domain = domain.slice(1, -1);
      }
      // location.hostname excludes ports; accepting a host:port string here is
      // convenient for tests while keeping the emitted cache key contract-safe.
      if (/^[^:]+:\d+$/.test(domain)) {
        domain = domain.replace(/:\d+$/, '');
      }
      domain = domain.replace(/\.$/, '').toLowerCase();
      if (!domain || /\s/.test(domain) || domain.indexOf(':') !== -1) {
        throw new TypeError('domain must be a hostname without a port');
      }
      return domain;
    }

    function buildQuestionMaterial(stem, options) {
      var cleanedStem = cleanStemHtml(stem);
      var optionList = asArray(options);
      return cleanedStem + optionList.map(optionText).join('');
    }

    function resolveMd5(candidate) {
      var value = candidate;
      if (typeof value === 'function') {
        return value;
      }
      if (value && typeof value.md5 === 'function') {
        return value.md5;
      }
      if (value && typeof value.default === 'function') {
        return value.default;
      }
      if (typeof importedMd5 === 'function') {
        return importedMd5;
      }
      if (importedMd5 && typeof importedMd5.md5 === 'function') {
        return importedMd5.md5;
      }
      if (importedMd5 && typeof importedMd5.default === 'function') {
        return importedMd5.default;
      }
      if (globalRoot && typeof globalRoot.md5 === 'function') {
        return globalRoot.md5;
      }
      if (globalRoot && globalRoot.md5 && typeof globalRoot.md5.md5 === 'function') {
        return globalRoot.md5.md5;
      }
      return null;
    }

    function buildCacheKey(domainOrInput, stemOrMd5, optionsOrMd5, maybeMd5) {
      var domain;
      var stem;
      var options;
      var md5Candidate = maybeMd5;

      if (isRecord(domainOrInput)) {
        var input = domainOrInput;
        domain = input.domain !== undefined ? input.domain :
          (input.hostname !== undefined ? input.hostname : input.location);
        stem = input.cleanedStem !== undefined ? input.cleanedStem : input.stem;
        options = input.cleanedOptions !== undefined ? input.cleanedOptions : input.options;
        md5Candidate = stemOrMd5 !== undefined ? stemOrMd5 :
          (input.md5 !== undefined ? input.md5 : input.md5Fn);
      } else {
        domain = domainOrInput;
        stem = stemOrMd5;
        options = optionsOrMd5;
        if (typeof optionsOrMd5 === 'function' ||
            (optionsOrMd5 && typeof optionsOrMd5.md5 === 'function')) {
          md5Candidate = optionsOrMd5;
          options = [];
        }
      }

      var digestFunction = resolveMd5(md5Candidate);
      if (!digestFunction) {
        throw new Error('MD5 function is unavailable; pass lib/md5.js md5 function');
      }
      var material = buildQuestionMaterial(stem, options);
      var digest = toText(digestFunction(material)).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(digest)) {
        throw new Error('MD5 function must return a 32-character hexadecimal digest');
      }
      return 'cache:' + normalizeDomain(domain) + ':' + digest;
    }

    function buildDeepSeekPayload(input) {
      if (!isRecord(input)) {
        throw new TypeError('quiz request input must be an object');
      }
      var qtype = parseQuestionType(input.qtype !== undefined ? input.qtype :
        (input.type !== undefined ? input.type : input.questionType));
      if (qtype === null) {
        throw new TypeError('qtype must be one of 0, 1, 2, 3 or 4');
      }
      var options = input.options === undefined ? [] : asArray(input.options).map(optionText);
      var payload = {
        domain: normalizeDomain(input.domain !== undefined ? input.domain : input.location),
        qtype: qtype,
        stem: input.cleanedStem !== undefined ? normalizeWhitespace(input.cleanedStem) : cleanStemHtml(input.stem),
        options: options
      };
      if (input.model !== undefined) {
        payload.model = toText(input.model);
      }
      if (input.temperature !== undefined) {
        payload.temperature = Number(input.temperature);
      }
      if (input.timeoutMs !== undefined) {
        payload.timeoutMs = Number(input.timeoutMs);
      }
      return payload;
    }

    function buildQuestionBankPayload(input) {
      if (!isRecord(input)) {
        throw new TypeError('quiz request input must be an object');
      }
      var qtype = parseQuestionType(input.qtype !== undefined ? input.qtype :
        (input.type !== undefined ? input.type : input.questionType));
      if (qtype === null) {
        throw new TypeError('qtype must be one of 0, 1, 2, 3 or 4');
      }
      return {
        domain: normalizeDomain(input.domain !== undefined ? input.domain : input.location),
        qtype: qtype,
        stem: input.cleanedStem !== undefined ? normalizeWhitespace(input.cleanedStem) : cleanStemHtml(input.stem),
        options: input.options === undefined ? [] : asArray(input.options).map(optionText)
      };
    }

    function buildCacheGetPayload(key) {
      return { key: toText(key) };
    }

    function buildCacheSetPayload(key, value) {
      return { key: toText(key), value: toText(value) };
    }

    // ==== SECTION: end quiz-core ====

    // ==== SECTION: quiz-call ====
    // 区块 B 只处理调用、缓存、答案匹配与 adapter 提供的填答动作；不持有站点选择器。

    var CALL_DEFAULT_ANSWER_INTERVAL_MS = 5000;
    var CALL_SOURCE = 'course-helper';
    var CALL_BACKGROUND_RESULT = 'BACKGROUND_RESULT';
    var CALL_MAIN_EDITOR_EVENT = 'course-helper:main:set-editor';
    var CALL_MAIN_MOBILE_EDITOR_EVENT = 'course-helper:main:set-mobile-editor';
    var callRequestSequence = 0;

    function callConsoleObject() {
      if (globalRoot && globalRoot.console) {
        return globalRoot.console;
      }
      if (typeof console !== 'undefined') {
        return console;
      }
      return null;
    }

    function callWarn(message, error) {
      var consoleObject = callConsoleObject();
      if (!consoleObject || typeof consoleObject.warn !== 'function') {
        return;
      }
      try {
        if (error) {
          consoleObject.warn('[course-helper] ' + message, error);
        } else {
          consoleObject.warn('[course-helper] ' + message);
        }
      } catch (ignoredWarnError) {
        // 控制台被页面替换时不能阻塞答题队列。
      }
    }

    function callNextRequestId(prefix) {
      callRequestSequence += 1;
      var timestamp;
      try {
        timestamp = Date.now();
      } catch (ignoredDateError) {
        timestamp = 0;
      }
      return (prefix || 'quiz') + '-' + String(timestamp) + '-' + String(callRequestSequence);
    }

    function callChromeObject() {
      if (globalRoot && globalRoot.chrome) {
        return globalRoot.chrome;
      }
      if (typeof globalThis !== 'undefined' && globalThis.chrome) {
        return globalThis.chrome;
      }
      return null;
    }

    function callRuntimeObject() {
      var chromeObject = callChromeObject();
      return chromeObject && chromeObject.runtime ? chromeObject.runtime : null;
    }

    function callError(code, message, retryable) {
      var error = new Error(message || 'background request failed');
      error.code = code || 'BACKGROUND_ERROR';
      error.retryable = Boolean(retryable);
      return error;
    }

    function callSendMessage(context, message) {
      var sender = context && typeof context.sendMessage === 'function'
        ? context.sendMessage
        : null;
      var runtime = callRuntimeObject();
      if (!sender && runtime && typeof runtime.sendMessage === 'function') {
        sender = function sendRuntimeMessage(request, callback) {
          return runtime.sendMessage(request, callback);
        };
      }
      if (!sender) {
        return Promise.reject(callError('RUNTIME_UNAVAILABLE',
          'chrome.runtime.sendMessage unavailable'));
      }

      return new Promise(function resolveMessage(resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        }
        function callback(value) {
          var runtimeError = null;
          try {
            runtimeError = runtime && runtime.lastError ? runtime.lastError : null;
          } catch (ignoredLastError) {
            runtimeError = null;
          }
          if (runtimeError) {
            finish(callError('RUNTIME_ERROR', runtimeError.message || String(runtimeError)));
            return;
          }
          finish(null, value);
        }

        var result;
        try {
          result = sender.call(context || null, message, callback);
        } catch (sendError) {
          finish(sendError);
          return;
        }
        if (result && typeof result.then === 'function') {
          result.then(function resolvePromise(value) {
            finish(null, value);
          }, function rejectPromise(error) {
            finish(error);
          });
        } else if (result !== undefined) {
          // Context adapters commonly return a synchronous test double.
          finish(null, result);
        }
        // Callback-based chrome APIs settle through callback().
      });
    }

    function callBackgroundRequest(type, payload, context) {
      var requestId = callNextRequestId('quiz');
      var message = {
        type: type,
        requestId: requestId,
        payload: payload
      };
      return callSendMessage(context, message).then(function normalizeResponse(response) {
        if (response && response.type === CALL_BACKGROUND_RESULT) {
          if (response.requestId && response.requestId !== requestId) {
            throw callError('REQUEST_ID_MISMATCH', 'background response requestId mismatch');
          }
          if (response.ok !== true) {
            var responseError = response.error || {};
            throw callError(responseError.code || 'BACKGROUND_ERROR',
              responseError.message || 'background request failed', responseError.retryable);
          }
          return response.data;
        }
        // A small direct return is accepted for adapter/test doubles; emitted
        // extension messages above always use the frozen BACKGROUND_RESULT contract.
        if (response && response.ok === false) {
          throw callError(response.error && response.error.code,
            response.error && response.error.message, response.error && response.error.retryable);
        }
        if (response && Object.prototype.hasOwnProperty.call(response, 'data')) {
          return response.data;
        }
        return response;
      });
    }

    function callSettings(context, question) {
      var settings = context && isRecord(context.settings) ? context.settings : {};
      var questionSettings = question && isRecord(question.settings) ? question.settings : {};
      return {
        settings: settings,
        questionSettings: questionSettings
      };
    }

    function callSettingValue(context, question, name) {
      var sources = callSettings(context, question);
      var questionSettings = sources.questionSettings;
      var settings = sources.settings;
      if (question && question[name] !== undefined) {
        return question[name];
      }
      if (questionSettings[name] !== undefined) {
        return questionSettings[name];
      }
      if (context && context[name] !== undefined) {
        return context[name];
      }
      return settings[name];
    }

    function callAnswerInterval(context, question) {
      var candidate = callSettingValue(context, question, 'answerIntervalMs');
      if (candidate === undefined || candidate === null || candidate === '') {
        return CALL_DEFAULT_ANSWER_INTERVAL_MS;
      }
      var interval = Number(candidate);
      if (!Number.isFinite(interval) || interval < 0) {
        return CALL_DEFAULT_ANSWER_INTERVAL_MS;
      }
      return Math.floor(interval);
    }

    function callDelay(milliseconds) {
      if (!milliseconds || milliseconds < 1) {
        return Promise.resolve();
      }
      return new Promise(function waitForDelay(resolve) {
        setTimeout(resolve, milliseconds);
      });
    }

    function callLocationCandidate(context, question) {
      if (question && question.domain !== undefined) {
        return question.domain;
      }
      if (question && question.hostname !== undefined) {
        return question.hostname;
      }
      if (context && context.domain !== undefined) {
        return context.domain;
      }
      if (context && context.location) {
        return context.location;
      }
      if (globalRoot && globalRoot.location) {
        return globalRoot.location;
      }
      // This fallback is only for node/unit-test callers without Location.
      return 'localhost';
    }

    function callQuestionQtype(question) {
      if (!question || !isRecord(question)) {
        return null;
      }
      return question.qtype !== undefined ? question.qtype :
        (question.type !== undefined ? question.type :
          (question.questionType !== undefined ? question.questionType : question.kind));
    }

    function callQuestionStem(question) {
      if (!question || !isRecord(question)) {
        return '';
      }
      if (question.stem !== undefined) {
        return question.stem;
      }
      if (question.questionStem !== undefined) {
        return question.questionStem;
      }
      if (question.title !== undefined) {
        return question.title;
      }
      if (question.text !== undefined) {
        return question.text;
      }
      return question.content === undefined ? '' : question.content;
    }

    function callOptionPayloadValue(option) {
      if (option === null || option === undefined) {
        return option;
      }
      if (isRecord(option)) {
        if (option.html !== undefined || option.text !== undefined ||
            option.label !== undefined || option.value !== undefined) {
          return option;
        }
        if (option.element !== undefined) {
          return callOptionPayloadValue(option.element);
        }
        if (option.node !== undefined) {
          return callOptionPayloadValue(option.node);
        }
        if (option.target !== undefined) {
          return callOptionPayloadValue(option.target);
        }
      }
      if (typeof option === 'object') {
        try {
          if (option.innerHTML !== undefined) {
            return option.innerHTML;
          }
          if (option.textContent !== undefined) {
            return option.textContent;
          }
        } catch (ignoredOptionTextError) {
          return option;
        }
      }
      return option;
    }

    function callRawQuestionOptions(question) {
      if (!question || !isRecord(question)) {
        return [];
      }
      var source;
      if (question.options !== undefined) {
        source = question.options;
      } else if (question.choices !== undefined) {
        source = question.choices;
      } else if (question.optionElements !== undefined) {
        source = question.optionElements;
      } else {
        source = [];
      }
      return asArray(source);
    }

    function callQuestionOptions(question) {
      var source;
      if (question && question.cleanedOptions !== undefined) {
        source = question.cleanedOptions;
      } else {
        source = callRawQuestionOptions(question).map(callOptionPayloadValue);
      }
      return asArray(source);
    }

    function callRequestInput(question, context) {
      var sources = callSettings(context, question);
      var settings = sources.settings;
      var input = {
        domain: callLocationCandidate(context, question),
        qtype: callQuestionQtype(question),
        stem: callQuestionStem(question),
        options: callQuestionOptions(question)
      };
      if (question && question.cleanedStem !== undefined) {
        input.cleanedStem = question.cleanedStem;
      }

      var model = question && question.model !== undefined ? question.model : settings.deepseekModel;
      var temperature = question && question.temperature !== undefined
        ? question.temperature : settings.deepseekTemperature;
      var timeoutMs = question && question.timeoutMs !== undefined
        ? question.timeoutMs : settings.deepseekTimeoutMs;
      if (model !== undefined && model !== null && String(model).trim()) {
        input.model = model;
      }
      if (temperature !== undefined && temperature !== null && temperature !== '') {
        input.temperature = temperature;
      }
      if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs !== '') {
        input.timeoutMs = timeoutMs;
      }
      return input;
    }

    function callMd5Candidate(question, context) {
      if (question && question.md5 !== undefined) {
        return question.md5;
      }
      if (question && question.md5Fn !== undefined) {
        return question.md5Fn;
      }
      if (context && context.md5 !== undefined) {
        return context.md5;
      }
      if (context && context.md5Fn !== undefined) {
        return context.md5Fn;
      }
      return undefined;
    }

    function callCacheKey(question, context, requestInput) {
      var md5Candidate = callMd5Candidate(question, context);
      if (!md5Candidate) {
        md5Candidate = resolveMd5();
      }
      if (!md5Candidate && typeof require === 'function') {
        try {
          md5Candidate = require('../lib/md5.js');
        } catch (ignoredMd5RequireError) {
          md5Candidate = null;
        }
      }
      if (!md5Candidate) {
        throw new Error('MD5 function is unavailable; pass lib/md5.js md5 function');
      }
      return buildCacheKey({
        domain: requestInput.domain,
        stem: requestInput.stem,
        options: requestInput.options,
        md5: md5Candidate
      });
    }

    function callAnswerFromData(data) {
      if (typeof data === 'string') {
        return data.trim();
      }
      if (data && typeof data.answer === 'string') {
        return data.answer.trim();
      }
      return '';
    }

    function callCachedValue(data) {
      if (!data || data.found !== true || typeof data.value !== 'string') {
        return null;
      }
      return data.value.trim();
    }

    async function callRequestAnswer(question, context) {
      var requestInput;
      try {
        requestInput = callRequestInput(question, context || {});
      } catch (inputError) {
        callWarn('构造答题请求失败，跳过该题。', inputError);
        return null;
      }

      var cacheKey = null;
      try {
        cacheKey = callCacheKey(question, context || {}, requestInput);
      } catch (cacheKeyError) {
        // 缺少 md5 资源时仍允许 API 答题；不能让缓存问题阻塞队列。
        callWarn('无法生成答题缓存 key，本题继续请求 API。', cacheKeyError);
      }

      if (cacheKey) {
        try {
          var cacheData = await callBackgroundRequest('CACHE_GET',
            buildCacheGetPayload(cacheKey), context || {});
          var cachedAnswer = callCachedValue(cacheData);
          if (cachedAnswer !== null) {
            return cachedAnswer;
          }
        } catch (cacheGetError) {
          callWarn('读取答题缓存失败，本题继续请求 API。', cacheGetError);
        }
      }

      // 题库 API（唯一题库来源）：命中直接返回并回写缓存；未配置/未命中/失败时继续 DeepSeek 兜底。
      try {
        var bankPayload = buildQuestionBankPayload(requestInput);
        var bankData = await callBackgroundRequest('QUESTION_BANK_LOOKUP', bankPayload, context || {});
        if (bankData && bankData.found === true) {
          var bankAnswer = callAnswerFromData(bankData);
          if (bankAnswer) {
            if (cacheKey) {
              try {
                await callBackgroundRequest('CACHE_SET',
                  buildCacheSetPayload(cacheKey, bankAnswer), context || {});
              } catch (bankCacheSetError) {
                callWarn('题库答案写入缓存失败，继续填答。', bankCacheSetError);
              }
            }
            return bankAnswer;
          }
        }
      } catch (bankLookupError) {
        callWarn('题库 API 查询失败，继续 DeepSeek 求解。', bankLookupError);
      }

      var payload;
      try {
        payload = buildDeepSeekPayload(requestInput);
      } catch (payloadError) {
        callWarn('构造 DeepSeek 请求失败，跳过该题。', payloadError);
        return null;
      }

      var data;
      try {
        data = await callBackgroundRequest('DEEPSEEK_CHAT', payload, context || {});
      } catch (apiError) {
        callWarn('DeepSeek API 请求失败，跳过该题。', apiError);
        return null;
      }
      var answer = callAnswerFromData(data);
      if (!answer) {
        callWarn('DeepSeek 未返回答案，跳过该题。');
        return null;
      }

      if (cacheKey) {
        try {
          await callBackgroundRequest('CACHE_SET', buildCacheSetPayload(cacheKey, answer), context || {});
        } catch (cacheSetError) {
          // 写缓存失败不影响当前题已经取得的答案。
          callWarn('写入答题缓存失败，继续填答。', cacheSetError);
        }
      }
      return answer;
    }

    function callUnwrapTarget(target) {
      if (target && isRecord(target)) {
        if (target.element !== undefined) {
          return target.element;
        }
        if (target.node !== undefined) {
          return target.node;
        }
        if (target.input !== undefined) {
          return target.input;
        }
        if (target.target !== undefined &&
            (target.target !== target || typeof target.target !== 'function')) {
          return target.target;
        }
      }
      return target;
    }

    async function callClickTarget(target) {
      var candidate = callUnwrapTarget(target);
      if (typeof candidate === 'function') {
        return candidate();
      }
      if (candidate && typeof candidate.click === 'function') {
        return candidate.click();
      }
      throw callError('CLICK_UNAVAILABLE', 'adapter did not provide a clickable target');
    }

    function callInputEvent(element) {
      var ownerDocument = null;
      try {
        ownerDocument = element && element.ownerDocument ? element.ownerDocument : null;
      } catch (ignoredOwnerDocumentError) {
        ownerDocument = null;
      }
      var view = ownerDocument && ownerDocument.defaultView ? ownerDocument.defaultView : globalRoot;
      var EventConstructor = view && typeof view.Event === 'function' ? view.Event : null;
      if (!EventConstructor && typeof Event === 'function') {
        EventConstructor = Event;
      }
      var event = null;
      try {
        if (EventConstructor) {
          event = new EventConstructor('input', { bubbles: true });
        }
      } catch (ignoredEventConstructorError) {
        event = null;
      }
      if (!event && ownerDocument && typeof ownerDocument.createEvent === 'function') {
        try {
          event = ownerDocument.createEvent('Event');
          event.initEvent('input', true, true);
        } catch (ignoredCreateEventError) {
          event = null;
        }
      }
      if (!event) {
        event = { type: 'input', bubbles: true };
      }
      if (element && typeof element.dispatchEvent === 'function') {
        element.dispatchEvent(event);
      }
      return event;
    }

    function callSetNativeValue(target, value) {
      var element = callUnwrapTarget(target);
      if (!element) {
        throw callError('INPUT_UNAVAILABLE', 'adapter did not provide an input target');
      }
      var text = value === null || value === undefined ? '' : String(value);
      var descriptor = null;
      var owner = element;
      while (owner && !descriptor) {
        try {
          descriptor = Object.getOwnPropertyDescriptor(owner, 'value') || null;
        } catch (ignoredDescriptorError) {
          descriptor = null;
        }
        try {
          owner = Object.getPrototypeOf(owner);
        } catch (ignoredPrototypeError) {
          owner = null;
        }
      }
      try {
        if (descriptor && typeof descriptor.set === 'function') {
          descriptor.set.call(element, text);
        } else {
          element.value = text;
        }
      } catch (setterError) {
        // Some test doubles expose a read-only descriptor but still accept a
        // direct assignment through a writable own property.
        try {
          element.value = text;
        } catch (assignmentError) {
          throw setterError || assignmentError;
        }
      }
      callInputEvent(element);
      return element;
    }

    function callMainTarget(context, payload) {
      var message = {
        source: CALL_SOURCE,
        type: payload.type,
        requestId: callNextRequestId('main'),
        payload: payload.payload
      };
      var customSender = context && typeof context.sendMainMessage === 'function'
        ? context.sendMainMessage : null;
      if (customSender) {
        return customSender.call(context, message);
      }
      customSender = context && typeof context.postMainMessage === 'function'
        ? context.postMainMessage : null;
      if (customSender) {
        return customSender.call(context, message);
      }

      var target = context && (context.mainWindow || context.window || context.pageWindow);
      if (!target && globalRoot && globalRoot.window) {
        target = globalRoot.window;
      }
      if (!target && globalRoot && typeof globalRoot.postMessage === 'function') {
        target = globalRoot;
      }
      if (!target || typeof target.postMessage !== 'function') {
        throw callError('MAIN_BRIDGE_UNAVAILABLE', 'window.postMessage unavailable');
      }
      target.postMessage(message, '*');
      return message;
    }

    function callEditorInput(editorOrId, content, context, mobile) {
      var editorId = editorOrId;
      var editorContent = content;
      var editorContext = context || {};
      if (isRecord(editorOrId)) {
        editorId = mobile ? editorOrId.index : editorOrId.editorId;
        editorContent = editorOrId.content !== undefined ? editorOrId.content : content;
        if (!context && editorOrId.context) {
          editorContext = editorOrId.context;
        }
      }
      if (mobile) {
        var mobilePayload = {
          index: Number(editorId),
          content: editorContent === null || editorContent === undefined ? '' : String(editorContent)
        };
        if (isRecord(editorOrId) && editorOrId.itemId !== undefined) {
          mobilePayload.itemId = String(editorOrId.itemId);
        }
        if (!Number.isInteger(mobilePayload.index) || mobilePayload.index < 0) {
          throw callError('EDITOR_INVALID', 'mobile editor index is invalid');
        }
        return callMainTarget(editorContext, {
          type: CALL_MAIN_MOBILE_EDITOR_EVENT,
          payload: mobilePayload
        });
      }
      if (editorId === undefined || editorId === null || String(editorId) === '') {
        throw callError('EDITOR_INVALID', 'editorId is required');
      }
      return callMainTarget(editorContext, {
        type: CALL_MAIN_EDITOR_EVENT,
        payload: {
          editorId: String(editorId),
          content: editorContent === null || editorContent === undefined ? '' : String(editorContent)
        }
      });
    }

    function callActions(context) {
      var actionContext = context || {};
      return {
        click: callClickTarget,
        clickTarget: callClickTarget,
        setNativeValue: callSetNativeValue,
        setValue: callSetNativeValue,
        writeMainEditor: function writeBoundMainEditor(editorId, content) {
          return callEditorInput(editorId, content, actionContext, false);
        },
        setEditor: function writeBoundEditor(editorId, content) {
          return callEditorInput(editorId, content, actionContext, false);
        },
        writeMobileEditor: function writeBoundMobileEditor(index, content, itemId) {
          return callEditorInput({ index: index, content: content, itemId: itemId },
            undefined, actionContext, true);
        },
        setMobileEditor: function setBoundMobileEditor(index, content, itemId) {
          return callEditorInput({ index: index, content: content, itemId: itemId },
            undefined, actionContext, true);
        }
      };
    }

    function callFirstFunction(question, context, names) {
      var actions = question && isRecord(question.actions) ? question.actions : {};
      var contextActions = context && isRecord(context.actions) ? context.actions : {};
      var candidates = [];
      names.forEach(function addName(name) {
        candidates.push(question && question[name]);
        candidates.push(actions[name]);
        candidates.push(contextActions[name]);
        candidates.push(context && context[name]);
      });
      for (var index = 0; index < candidates.length; index += 1) {
        if (typeof candidates[index] === 'function') {
          return candidates[index];
        }
      }
      return null;
    }

    function callAnsweredCandidate(question, context) {
      var callback = callFirstFunction(question, context, ['isAnswered', 'answeredCheck', 'checkAnswered']);
      if (callback) {
        return callback;
      }
      if (question && typeof question.answered === 'boolean') {
        return question.answered;
      }
      if (question && typeof question.completed === 'boolean') {
        return question.completed;
      }
      if (question && typeof question.done === 'boolean') {
        return question.done;
      }
      return false;
    }

    async function callIsAnswered(question, context) {
      var candidate = callAnsweredCandidate(question, context);
      if (typeof candidate === 'function') {
        try {
          return Boolean(await candidate.call(question, question, context));
        } catch (answeredError) {
          callWarn('已答检测失败，按未答题继续。', answeredError);
          return false;
        }
      }
      return Boolean(candidate);
    }

    function callFillResult(value, reason) {
      if (value && isRecord(value)) {
        if (value.filled !== undefined) {
          return {
            filled: Boolean(value.filled),
            skipped: Boolean(value.skipped),
            reason: value.reason || reason,
            detail: value
          };
        }
        if (value.ok !== undefined) {
          return {
            filled: Boolean(value.ok),
            skipped: false,
            reason: value.reason || reason,
            detail: value
          };
        }
      }
      if (value === false) {
        return { filled: false, skipped: false, reason: reason || 'fill-failed' };
      }
      return { filled: true, skipped: false, reason: reason, detail: value };
    }

    function callOptionTarget(option) {
      if (option && isRecord(option)) {
        if (option.element !== undefined) {
          return option.element;
        }
        if (option.node !== undefined) {
          return option.node;
        }
        if (option.target !== undefined) {
          return option.target;
        }
      }
      return option;
    }

    async function callFillChoiceAnswer(question, answer, qtype, context, helpers) {
      var rawOptions = callRawQuestionOptions(question);
      var optionTexts = callQuestionOptions(question);
      var matches = matchAnswerToOptions(answer, optionTexts, qtype);
      if (!matches.length) {
        return { filled: false, skipped: true, reason: 'no-option-match' };
      }
      var clickCallback = callFirstFunction(question, context,
        ['clickOption', 'clickAnswer', 'clickChoice']);
      var genericClick = callFirstFunction(question, context, ['click']);
      for (var index = 0; index < matches.length; index += 1) {
        var optionIndex = matches[index];
        var option = rawOptions[optionIndex];
        try {
          if (clickCallback) {
            var callbackResult = await clickCallback.call(question, optionIndex, option,
              answer, helpers);
            if (callbackResult === false) {
              return { filled: false, skipped: false, reason: 'click-failed' };
            }
          } else if (genericClick) {
            var genericResult = await genericClick.call(question, optionIndex, option,
              answer, helpers);
            if (genericResult === false) {
              return { filled: false, skipped: false, reason: 'click-failed' };
            }
          } else {
            await callClickTarget(callOptionTarget(option));
          }
        } catch (clickError) {
          callWarn('选项填答失败，跳过该题。', clickError);
          return { filled: false, skipped: false, reason: 'click-failed' };
        }
      }
      return { filled: true, skipped: false, matched: matches };
    }

    function callFieldCandidates(question) {
      if (!question || !isRecord(question)) {
        return [];
      }
      var source = question.inputs !== undefined ? question.inputs :
        (question.textareas !== undefined ? question.textareas :
          (question.fields !== undefined ? question.fields :
            (question.answerInputs !== undefined ? question.answerInputs : question.blankInputs)));
      return source === undefined ? [] : asArray(source);
    }

    function callEditorCandidates(question, qtype) {
      if (!question || !isRecord(question)) {
        return [];
      }
      var source;
      if (question.editorIds !== undefined) {
        source = question.editorIds;
      } else if (question.editors !== undefined) {
        source = question.editors;
      } else if (question.ueEditors !== undefined) {
        source = question.ueEditors;
      } else if (question.editorId !== undefined) {
        source = question.editorId;
      } else if (question.mainEditor !== undefined) {
        source = question.mainEditor;
      } else if (qtype === 2 && question.editorIndexes !== undefined) {
        source = question.editorIndexes;
      } else {
        source = [];
      }
      return source === undefined ? [] : asArray(source);
    }

    async function callWriteField(field, value, index, question, context, helpers) {
      if (typeof field === 'function') {
        return field.call(question, value, index, helpers);
      }
      if (field && isRecord(field)) {
        if (typeof field.setValue === 'function') {
          return field.setValue.call(field, value, index, helpers);
        }
        if (typeof field.setContent === 'function') {
          return field.setContent.call(field, value, index, helpers);
        }
        if (field.mobileEditorIndex !== undefined || field.mobileIndex !== undefined) {
          var mobileIndex = field.mobileEditorIndex !== undefined
            ? field.mobileEditorIndex : field.mobileIndex;
          return callEditorInput({
            index: mobileIndex,
            content: value,
            itemId: field.itemId
          }, undefined, context, true);
        }
        if (field.editorId !== undefined) {
          return callEditorInput(field.editorId, value, context, false);
        }
        if (field.element !== undefined || field.node !== undefined || field.input !== undefined) {
          return callSetNativeValue(field, value);
        }
      }
      var element = callUnwrapTarget(field);
      if (element && (typeof element.dispatchEvent === 'function' || 'value' in element)) {
        return callSetNativeValue(element, value);
      }

      var setValueCallback = callFirstFunction(question, context, ['setValue', 'setInputValue']);
      if (setValueCallback) {
        return setValueCallback.call(question, field, value, index, helpers);
      }
      return false;
    }

    async function callFillTextAnswer(question, answer, qtype, context, helpers) {
      var customSetEditor = callFirstFunction(question, context, ['setEditor', 'writeEditor']);
      var fields = callFieldCandidates(question);
      var editors = callEditorCandidates(question, qtype);
      var text = answer === null || answer === undefined ? '' : String(answer);
      var values = qtype === 2 ? text.split(/\s*#\s*/) : [text];
      if (fields.length === 1 && qtype === 2 && values.length > 1 && !editors.length) {
        values = [text];
      }

      if (fields.length) {
        var fieldCount = Math.min(fields.length, values.length);
        var filledFields = 0;
        for (var fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
          try {
            var fieldResult = await callWriteField(fields[fieldIndex], values[fieldIndex],
              fieldIndex, question, context, helpers);
            if (fieldResult === false) {
              return { filled: false, skipped: false, reason: 'input-write-failed' };
            }
            filledFields += 1;
          } catch (fieldError) {
            callWarn('文本填答失败，跳过该题。', fieldError);
            return { filled: false, skipped: false, reason: 'input-write-failed' };
          }
        }
        return { filled: filledFields > 0, skipped: false, filledFields: filledFields };
      }

      if (editors.length) {
        var editorValues = editors.length === 1 && qtype !== 2 ? [text] : values;
        var editorCount = Math.min(editors.length, editorValues.length);
        var filledEditors = 0;
        for (var editorIndex = 0; editorIndex < editorCount; editorIndex += 1) {
          var editor = editors[editorIndex];
          try {
            var editorResult;
            if (customSetEditor) {
              editorResult = await customSetEditor.call(question, editor, editorValues[editorIndex],
                editorIndex, helpers);
            } else if (editor && isRecord(editor) && editor.mobileEditorIndex !== undefined) {
              editorResult = await callEditorInput({
                index: editor.mobileEditorIndex,
                content: editorValues[editorIndex],
                itemId: editor.itemId
              }, undefined, context, true);
            } else if (editor && isRecord(editor) && editor.index !== undefined && editor.mobile) {
              editorResult = await callEditorInput({
                index: editor.index,
                content: editorValues[editorIndex],
                itemId: editor.itemId
              }, undefined, context, true);
            } else {
              var editorId = editor && isRecord(editor) && editor.editorId !== undefined
                ? editor.editorId : editor;
              editorResult = await callEditorInput(editorId, editorValues[editorIndex], context, false);
            }
            if (editorResult === false) {
              return { filled: false, skipped: false, reason: 'editor-write-failed' };
            }
            filledEditors += 1;
          } catch (editorError) {
            callWarn('编辑器填答失败，跳过该题。', editorError);
            return { filled: false, skipped: false, reason: 'editor-write-failed' };
          }
        }
        return { filled: filledEditors > 0, skipped: false, filledEditors: filledEditors };
      }

      var directFill = callFirstFunction(question, context, ['setAnswer', 'fillText', 'fillInput']);
      if (directFill) {
        try {
          var directResult = await directFill.call(question, text, helpers);
          return callFillResult(directResult, 'direct-fill');
        } catch (directError) {
          callWarn('adapter 文本填答回调失败，跳过该题。', directError);
          return { filled: false, skipped: false, reason: 'direct-fill-failed' };
        }
      }
      return { filled: false, skipped: true, reason: 'no-fill-action' };
    }

    async function callFillSortableAnswer(question, answer, context, helpers) {
      // 排序/拖拽题（qtype=5）：通过 Touch 事件序列模拟拖拽
      // answer 格式预期：数组，如 ["选项C", "选项A", "选项B"] 表示正确顺序
      // question.sortableWrapper: 排序容器元素
      // question.sortableItems: 可拖拽元素数组
      
      var sortableWrapper = question && question.sortableWrapper;
      var sortableItems = question && question.sortableItems;
      if (!sortableWrapper || !sortableItems || !sortableItems.length) {
        return { filled: false, skipped: true, reason: 'no-sortable-elements' };
      }
      
      var text = answer === null || answer === undefined ? '' : String(answer);
      var targetOrder = [];
      try {
        // 解析答案：支持 "A,B,C" 或 ["A","B","C"] 或 "选项C,选项A,选项B"
        if (Array.isArray(answer)) {
          targetOrder = answer.map(String);
        } else if (typeof answer === 'string') {
          // 尝试解析为数组
          var parsed = text.split(/[,，#]/).map(s => s.trim()).filter(Boolean);
          targetOrder = parsed.length ? parsed : [String(answer)];
        } else {
          targetOrder = [String(answer)];
        }
      } catch (_e) {
        targetOrder = [String(answer)];
      }
      
      if (!targetOrder.length) {
        return { filled: false, skipped: true, reason: 'empty-answer' };
      }
      
      try {
        // 获取当前页面中的可拖拽元素（实时查询，因为页面可能重渲染）
        var doc = question.sortableWrapper ? question.sortableWrapper.ownerDocument : document;
        var currentWrapper = doc.querySelector('.sortable-list-wrapper, .sequence-container, .sequence-pc-card, [class*="sortable"], [class*="sequence"]');
        if (!currentWrapper) {
          return { filled: false, skipped: true, reason: 'wrapper-not-found' };
        }
        var items = [...currentWrapper.querySelectorAll('li, [draggable], .sortable-item, .sequence-item, .sequence-pc-card--item')];
        if (!items.length || items.length < 2) {
          return { filled: false, skipped: true, reason: 'no-draggable-items' };
        }
        
        // 根据答案文本匹配当前元素的正确位置
        // 这里简化：假设答案数组顺序即为目标顺序，按顺序拖拽到位
        // 实际项目中需要根据选项文本匹配
        var success = true;
        var moved = 0;
        
        for (var i = 0; i < targetOrder.length && i < items.length; i++) {
          var targetText = targetOrder[i];
          // 找到包含目标文本的元素
          var targetItem = null;
          for (var j = i; j < items.length; j++) {
            var itemText = (items[j].textContent || '').trim().replace(/\s+/g, ' ');
            if (itemText.includes(targetText) || targetText.includes(itemText)) {
              targetItem = items[j];
              break;
            }
          }
          if (!targetItem) {
            // 如果找不到精确匹配，按索引直接移动
            targetItem = items[i];
          }
          
          if (targetItem && targetItem !== items[i]) {
            // 执行拖拽：将 targetItem 拖拽到位置 i
            var success = await dragAndDropToIndex(currentWrapper, targetItem, i, items);
            if (success) {
              moved++;
              // 重新获取元素列表（DOM 可能已变化）
              var currentItems = [...currentWrapper.querySelectorAll('li, [draggable], .sortable-item, .sequence-item, .sequence-pc-card--item')];
              items = currentItems;
            } else {
              success = false;
            }
          }
        }
        
        return { filled: true, skipped: false, moved: moved };
      } catch (e) {
        callWarn('排序题填答异常: ' + e.message);
        return { filled: false, skipped: false, reason: 'sortable-fill-error' };
      }
    }
    
    async function dragAndDropToIndex(wrapper, sourceElement, targetIndex, currentItems) {
      // 简化版 Touch 拖拽：sourceElement 拖拽到 targetIndex 位置
      // 实际需要根据平台具体实现调整
      try {
        var rect = sourceElement.getBoundingClientRect();
        var startX = rect.left + rect.width / 2;
        var startY = rect.top + rect.height / 2;
        
        // 计算目标位置
        var targetElement = currentItems[targetIndex];
        if (!targetElement) return false;
        var targetRect = targetElement.getBoundingClientRect();
        var endX = targetRect.left + targetRect.width / 2;
        var endY = targetRect.top + targetRect.height / 2;
        
        // 创建 Touch 事件序列
        var touchId = 1;
        var touchOpts = { bubbles: true, cancelable: true, view: window, clientX: startX, clientY: startY };
        var touch = new Touch({ identifier: touchId, target: sourceElement, clientX: startX, clientY: startY, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        
        // touchstart
        sourceElement.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, view: window, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        await new Promise(r => setTimeout(r, 50));
        
        // touchmove (中间点)
        var midX = (startX + endX) / 2;
        var midY = (startY + endY) / 2;
        touch = new Touch({ identifier: touchId, target: sourceElement, clientX: midX, clientY: midY, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        sourceElement.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, view: window, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        await new Promise(r => setTimeout(r, 50));
        
        // touchmove (终点)
        touch = new Touch({ identifier: touchId, target: sourceElement, clientX: endX, clientY: endY, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        sourceElement.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, view: window, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
        await new Promise(r => setTimeout(r, 50));
        
        // touchend
        touch = new Touch({ identifier: touchId, target: sourceElement, clientX: endX, clientY: endY, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 });
        sourceElement.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, view: window, touches: [], targetTouches: [], changedTouches: [touch] }));
        await new Promise(r => setTimeout(r, 100));
        
        return true;
      } catch (e) {
        return false;
      }
    }

    async function callFillQuestionAnswer(question, answer, context) {
      context = context || {};
      if (!question || !isRecord(question)) {
        return { filled: false, skipped: true, reason: 'invalid-question' };
      }
      var qtype = parseQuestionType(callQuestionQtype(question));
      if (qtype === null) {
        return { filled: false, skipped: true, reason: 'invalid-qtype' };
      }
      var helpers = callActions(context);
      helpers.question = question;
      helpers.context = context;
      helpers.qtype = qtype;
      helpers.matchAnswerToOptions = matchAnswerToOptions;

      var customFill = callFirstFunction(question, context, ['fillAnswer', 'applyAnswer', 'fill']);
      if (customFill) {
        try {
          var customResult = await customFill.call(question, answer, helpers);
          return callFillResult(customResult, 'adapter-fill');
        } catch (customError) {
          callWarn('adapter 填答回调失败，跳过该题。', customError);
          return { filled: false, skipped: false, reason: 'adapter-fill-failed' };
        }
      }

      if (qtype === 0 || qtype === 1 || qtype === 3) {
        return callFillChoiceAnswer(question, answer, qtype, context, helpers);
      }
      if (qtype === 5) {
        return callFillSortableAnswer(question, answer, context, helpers);
      }
      return callFillTextAnswer(question, answer, qtype, context, helpers);
    }

    function callSubmitTarget(context, options) {
      var optionObject = options && isRecord(options) ? options : {};
      if (optionObject.submit !== undefined) {
        return optionObject.submit;
      }
      if (context && context.submit !== undefined) {
        return context.submit;
      }
      if (context && context.submitQuiz !== undefined) {
        return context.submitQuiz;
      }
      var actions = context && isRecord(context.actions) ? context.actions : {};
      return actions.submit;
    }

    async function callSubmitQuiz(context, options) {
      context = context || {};
      var target = callSubmitTarget(context, options);
      if (target === undefined || target === null) {
        return { submitted: false, skipped: true, reason: 'no-submit-action' };
      }
      try {
        var result = typeof target === 'function'
          ? await target.call(context, context)
          : await callClickTarget(target);
        if (result === false) {
          return { submitted: false, skipped: false, reason: 'submit-failed' };
        }
        return { submitted: true, skipped: false, detail: result };
      } catch (submitError) {
        callWarn('提交动作失败。', submitError);
        return { submitted: false, skipped: false, reason: 'submit-failed' };
      }
    }

    async function callSolveQuestion(question, context, index, hasPreviousAttempt) {
      if (await callIsAnswered(question, context)) {
        return { index: index, solved: false, skipped: true, reason: 'already-answered' };
      }
      if (hasPreviousAttempt) {
        await callDelay(callAnswerInterval(context, question));
      }
      var answer = await callRequestAnswer(question, context);
      if (!answer) {
        return { index: index, solved: false, skipped: true, reason: 'no-answer' };
      }
      var fillResult;
      try {
        fillResult = await callFillQuestionAnswer(question, answer, context);
      } catch (fillError) {
        callWarn('填答过程异常，跳过该题。', fillError);
        fillResult = { filled: false, skipped: false, reason: 'fill-failed' };
      }
      if (!fillResult || !fillResult.filled) {
        return {
          index: index,
          solved: false,
          skipped: Boolean(fillResult && fillResult.skipped),
          reason: fillResult && fillResult.reason ? fillResult.reason : 'fill-failed',
          answer: answer
        };
      }
      return { index: index, solved: true, skipped: false, answer: answer, fill: fillResult };
    }

    async function callSolveQuestions(questions, context, options) {
      context = context || {};
      var solveOptions = options && isRecord(options) ? options : {};
      var list = Array.isArray(questions) ? questions :
        (questions && Array.isArray(questions.questions) ? questions.questions : []);
      // 并发求解：仅当调用方显式传 options.concurrency（正整数）时启用，
      // 默认 1 = 原有串行行为（各平台适配器未传时不受影响）。
      var concurrency = Number(solveOptions.concurrency);
      if (!Number.isFinite(concurrency) || concurrency < 1 ||
          Math.floor(concurrency) !== concurrency) {
        concurrency = 1;
      }
      var results = [];
      var solvedCount = 0;
      var skippedCount = 0;
      var failedCount = 0;
      var attempted = false;

      var batchIndex = 0;
      while (batchIndex < list.length) {
        if (attempted) {
          // 批间延迟一次（批内并发）：与串行模式"每题间隔"同级的防突发节奏。
          await callDelay(callAnswerInterval(context));
        }
        var batch = list.slice(batchIndex, batchIndex + concurrency);
        var batchResults;
        if (concurrency === 1) {
          batchResults = [];
          try {
            batchResults.push(await callSolveQuestion(batch[0], context, batchIndex, false));
          } catch (questionError) {
            callWarn('题目处理异常，继续下一题。', questionError);
            batchResults.push({ index: batchIndex, solved: false, skipped: false, reason: 'question-failed' });
          }
        } else {
          batchResults = await Promise.all(batch.map(function solveOne(question, offset) {
            var index = batchIndex + offset;
            return callSolveQuestion(question, context, index, false)
              .catch(function (questionError) {
                callWarn('题目处理异常，继续下一题。', questionError);
                return { index: index, solved: false, skipped: false, reason: 'question-failed' };
              });
          }));
        }
        for (var resultIndex = 0; resultIndex < batchResults.length; resultIndex += 1) {
          var result = batchResults[resultIndex];
          results.push(result);
          if (result.solved) {
            solvedCount += 1;
            attempted = true;
          } else if (result.skipped) {
            skippedCount += 1;
          } else {
            failedCount += 1;
          }
          // An API failure/no-answer still consumed an attempt slot, so a burst
          // of requests cannot bypass the configured inter-question interval.
          if (result.reason !== 'already-answered') {
            attempted = true;
          }
        }
        batchIndex += concurrency;
      }

      var submitResult = null;
      var explicitSubmit = solveOptions.submit !== undefined ||
        (context && context.submit !== undefined) || (context && context.submitQuiz !== undefined);
      var autoSubmit = solveOptions.autoSubmit !== undefined
        ? Boolean(solveOptions.autoSubmit)
        : (context.autoSubmit !== undefined
          ? Boolean(context.autoSubmit)
          : callSettingValue(context, null, 'autoSubmit') !== false);
      if (autoSubmit && explicitSubmit && solvedCount > 0) {
        submitResult = await callSubmitQuiz(context, solveOptions);
      }

      var summary = {
        done: true,
        skipped: solvedCount === 0,
        total: list.length,
        solved: solvedCount,
        answered: solvedCount,
        skippedCount: skippedCount,
        failed: failedCount,
        results: results
      };
      if (submitResult) {
        summary.submitted = Boolean(submitResult.submitted);
        summary.submit = submitResult;
      }
      if (!list.length) {
        summary.reason = 'no-questions';
      } else if (!solvedCount) {
        summary.reason = 'no-question-solved';
      }
      return summary;
    }

    var CALL_ACTIONS = Object.freeze({
      click: callClickTarget,
      clickTarget: callClickTarget,
      setNativeValue: callSetNativeValue,
      setValue: callSetNativeValue,
      writeMainEditor: callEditorInput,
      setEditor: callEditorInput,
      writeMobileEditor: function writeMobileEditorAction(input, content, context) {
        return callEditorInput(input, content, context, true);
      },
      setMobileEditor: function setMobileEditorAction(input, content, context) {
        return callEditorInput(input, content, context, true);
      }
    });

    var coreApi = {
      QUESTION_TYPES: QUESTION_TYPES,
      QUESTION_TYPE_MAP: QUESTION_TYPE_MAP,
      TYPE_MAP: QUESTION_TYPE_MAP,
      parseQuestionType: parseQuestionType,
      getQuestionType: parseQuestionType,
      cleanOptionHtml: cleanOptionHtml,
      cleanOption: cleanOptionHtml,
      cleanStemHtml: cleanStemHtml,
      cleanStem: cleanStemHtml,
      normalizeForCompare: normalizeForCompare,
      parseMultiAnswer: parseMultiAnswer,
      splitMultiAnswer: parseMultiAnswer,
      matchAnswerToOptions: matchAnswerToOptions,
      matchAnswer: matchAnswerToOptions,
      findOptionMatches: matchAnswerToOptions,
      matchAnswerIndex: matchAnswerIndex,
      getBlankCount: getBlankCount,
      countBlankFields: getBlankCount,
      countBlanks: getBlankCount,
      buildQuestionMaterial: buildQuestionMaterial,
      makeQuestionMaterial: buildQuestionMaterial,
      buildCacheKey: buildCacheKey,
      makeCacheKey: buildCacheKey,
      getCacheKey: buildCacheKey,
      resolveMd5: resolveMd5,
      buildDeepSeekPayload: buildDeepSeekPayload,
      buildQuizRequestPayload: buildDeepSeekPayload,
      buildQuestionBankPayload: buildQuestionBankPayload,
      buildCacheGetPayload: buildCacheGetPayload,
      buildCacheSetPayload: buildCacheSetPayload,
      requestAnswer: callRequestAnswer,
      getAnswer: callRequestAnswer,
      solveQuestion: callSolveQuestion,
      solveQuestions: callSolveQuestions,
      fillQuestion: callFillQuestionAnswer,
      fillAnswer: callFillQuestionAnswer,
      submitQuiz: callSubmitQuiz,
      delay: callDelay,
      actions: CALL_ACTIONS,
      createActions: callActions
    };
    // Add the CommonJS-compatible default reference before freezing the API.
    coreApi.default = coreApi;
    return Object.freeze(coreApi);
  }());

  if (globalRoot) {
    globalRoot.CourseHelperQuizSolver = api;
  }

  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis :
  (typeof self !== 'undefined' ? self :
    (typeof window !== 'undefined' ? window : this))),
  (function loadLocalMd5() {
    if (typeof require === 'function') {
      try {
        return require('../lib/md5.js');
      } catch (ignoredRequireError) {
        return null;
      }
    }
    return null;
  }()));

// ==== SECTION: end quiz-call ====
