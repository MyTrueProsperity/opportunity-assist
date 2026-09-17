(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OAGrantLimits = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function counts(text) {
    text = String(text || "").normalize("NFC");
    return {
      words: (text.trim().match(/\S+/gu) || []).length,
      characters: Array.from(text).length,
      characters_without_spaces: Array.from(text.replace(/\s/gu, "")).length,
    };
  }
  function check(text, question) {
    const c = counts(text),
      type = question.limit_type || "NONE",
      max = Number(question.limit_value);
    const value =
      type === "WORDS"
        ? c.words
        : type === "CHARACTERS_WITHOUT_SPACES" ||
            (type === "CHARACTERS" && question.spaces_count === false)
          ? c.characters_without_spaces
          : c.characters;
    return {
      ...c,
      value,
      max: Number.isFinite(max) && max > 0 ? max : null,
      over:
        !["NONE", "ADVISORY", "PAGES"].includes(type) && max > 0 && value > max,
      manual:
        type === "PAGES" ||
        (type === "CHARACTERS" && question.spaces_count == null),
    };
  }
  return {
    counts,
    check,
    countWords: (t) => counts(t).words,
    countCharacters: (t) => counts(t).characters,
    countCharactersWithoutSpaces: (t) => counts(t).characters_without_spaces,
  };
});
