/* Authored, offline UI examples. No AI request or dictionary citation is made. */
(() => {
  'use strict';
  const modes = {
    passage: ['구절 전체', '이 구절에서 함께 살펴볼 글자와 어휘는 무엇인가요?'],
    meaning: ['뜻풀이', '선택한 글자나 어휘를 이 문맥에서는 어떻게 읽을 수 있나요?'],
    reading: ['독음', '선택한 뜻에 맞는 독음을 함께 살펴볼까요?'],
    evidence: ['근거 확인', '이 풀이를 채택하려면 어떤 근거를 더 확인해야 하나요?']
  };
  const sampleNotice = '오프라인 화면 시연용 예시입니다. 실제 AI 분석이나 사전 인용이 아닙니다.';

  // Returns a fresh, occurrence-based result only when the caller requests it.
  // The authored fixtures are the mock response source, never a dictionary API.
  // Character indices are zero-based across clauses.flat(); group.to is exclusive.
  window.createReadingDemoAnalysis = function (passage) {
    const tokens = Array.isArray(passage?.clauses) ? passage.clauses.flat() : [];
    const characters = tokens.map((token, index) => {
      const quote = typeof token?.char === 'string' ? token.char : '';
      const candidates = Array.isArray(token?.senses) ? token.senses : [];
      const chosen = Number.isInteger(token?.chosen) && token.chosen >= 0
        ? candidates[token.chosen] : null;
      const unknown = quote.startsWith('餙');
      return {
        index,
        quote,
        reading: unknown ? '희' : chosen?.reading || token?.reading || '',
        basic: unknown ? '' : token?.basic || '',
        meaning: unknown ? '' : chosen?.text || '',
        explanation: unknown
          ? `원문 餙을 보존합니다. 독음 희만 표시하며 기본 훈과 문맥의 뜻은 근거 확인 전까지 미확인으로 둡니다. 다른 자형으로 바꾸거나 ‘꾸미다’로 확정하지 않습니다. ${sampleNotice}`
          : `${chosen?.explanation || candidates[0]?.explanation || '이 위치의 글자를 살펴보는 시연안입니다.'}${chosen ? '' : ' 문맥의 뜻은 미확정으로 둡니다.'} ${sampleNotice}`
      };
    });
    const groups = (Array.isArray(passage?.groups) ? passage.groups : [])
      .filter(group => group && Number.isInteger(group.from) && Number.isInteger(group.to)
        && group.from >= 0 && group.to > group.from && group.to <= tokens.length)
      .map(group => {
        const selected = characters.slice(group.from, group.to);
        const unknown = selected.some(character => character.quote.startsWith('餙'));
        return {
          id: String(group.id || `word-${group.from}-${group.to}`),
          from: group.from,
          to: group.to,
          quote: selected.map(character => character.quote).join(''),
          reading: unknown ? selected.map(character => character.reading).join('') : group.reading || '',
          meaning: unknown ? '' : group.sense || '',
          explanation: unknown
            ? `원문 餙을 포함한 어휘 묶음입니다. 자형을 보존하며 묶음의 뜻은 근거 확인 전까지 미확인으로 둡니다. ${sampleNotice}`
            : `${group.explanation || '여러 글자를 함께 읽는 시연 묶음입니다.'} ${sampleNotice}`
        };
      });
    return { characters, groups };
  };

  window.createReadingDemoProposal = function ({ passage, from = 0, to, mode = 'passage' } = {}) {
    const tokens = Array.isArray(passage?.clauses) ? passage.clauses.flat() : [];
    const groups = Array.isArray(passage?.groups) ? passage.groups : [];
    const kind = Object.hasOwn(modes, mode) ? mode : 'passage';
    const [label, question] = modes[kind];
    const bounded = (value, fallback) => Number.isInteger(value) ? Math.max(0, Math.min(tokens.length, value)) : fallback;
    const start = bounded(from, 0), end = Math.max(start, bounded(to, Math.min(start + 1, tokens.length)));
    const quote = (a, b) => tokens.slice(a, b).map(token => token.char).join('');
    const sense = token => {
      if (token.char.startsWith('餙')) return { text: '뜻 미확인', reading: '희', explanation: '원문 餙을 보존합니다. 이 예시에서는 독음 희만 표시하며 문맥의 뜻은 확정하지 않습니다.' };
      const candidates = Array.isArray(token.senses) ? token.senses : [];
      return candidates[Number.isInteger(token.chosen) ? token.chosen : 0] || candidates[0] || { text: '뜻 미확인', explanation: '' };
    };
    const reading = token => sense(token).reading || token.reading || '독음 미확인';

    function proposal(a, b) {
      const selected = tokens.slice(a, b);
      const exactGroup = groups.find(group => group.from === a && group.to === b);
      const meanings = [];
      // Preserve complete fixture word groups; partial selections stay separate.
      for (let i = a; i < b;) {
        const group = groups.find(item => item.from === i && item.to <= b && item.to > i);
        if (group) { meanings.push(group.sense); i = group.to; }
        else { meanings.push(sense(tokens[i]).text || '뜻 미확인'); i++; }
      }
      const hasUnknownGlyph = selected.some(token => token.char.startsWith('餙'));
      const notes = hasUnknownGlyph ? '원문 餙을 보존하며, 이를 포함한 표현의 뜻은 근거 확인 전까지 미확인으로 둡니다.'
        : exactGroup?.explanation || (selected.length === 1 ? sense(selected[0]).explanation : '선택 범위의 글자와 완전한 어휘 묶음을 나누어 살펴보는 예시입니다. 나열한 뜻을 문장 번역으로 확정하지 않습니다.');
      const proposedReading = hasUnknownGlyph ? selected.map(reading).join('') : exactGroup?.reading || selected.map(reading).join('');
      const explanation = kind === 'reading'
        ? `독음 후보는 ‘${proposedReading}’입니다. 뜻에 따라 독음이 달라지는 글자는 선택한 의미와 함께 확인합니다. ${notes || ''}`
        : kind === 'evidence'
          ? `확인할 항목: 원문 자형, 표제어의 해당 뜻, 앞뒤 문맥의 용법. ${notes || ''} 이 데모에는 실제 근거 자료가 연결되어 있지 않습니다.`
          : notes || '선택한 뜻 후보를 문맥에서 검토하는 시연입니다.';
      return {
        from: a, to: b, quote: quote(a, b), reading: proposedReading,
        meaning: hasUnknownGlyph ? '뜻 미확인' : exactGroup?.sense || meanings.join(' / '), explanation,
        caution: hasUnknownGlyph
          ? `餙의 뜻은 미확인입니다. 다른 자형으로 바꾸거나 ‘꾸미다’로 확정하지 않습니다. ${sampleNotice}`
          : sampleNotice
      };
    }

    let ranges = start < end ? [[start, end]] : [];
    if (kind === 'passage') {
      const curated = {
        gwanseo: [[0, 1], [1, 3], [17, 18], [18, 19]],
        analects: [[2, 3], [4, 5], [7, 8], [12, 14]],
        'great-learning': [[5, 6], [6, 8], [9, 10], [14, 16]]
      };
      ranges = curated[passage?.id] || groups.slice(0, 3).map(group => [group.from, group.to]);
      if (ranges.length < 2) {
        ranges = [...ranges, ...tokens.map((token, i) => [i, i + 1])]
          .filter((range, i, all) => all.findIndex(other => other[0] === range[0] && other[1] === range[1]) === i).slice(0, 4);
      }
    }
    ranges = ranges.filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= tokens.length).slice(0, kind === 'passage' ? 4 : 1);
    return {
      summary: ranges.length ? `${label} 검토를 위한 시연 제안 ${ranges.length}건입니다. 채택 전후의 화면 흐름을 살펴볼 수 있습니다.` : '살펴볼 글자나 어휘를 선택하세요.',
      suggestions: ranges.map(([a, b]) => proposal(a, b)), question,
      scopeLabel: kind === 'passage' ? `${passage?.title || '현재 구절'} · 전체 ${tokens.length}자` : `${quote(start, end) || '선택 없음'} · ${label}`
    };
  };
})();
