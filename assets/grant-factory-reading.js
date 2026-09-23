(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OAGrantReading = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  async function nextSection({ request, read, cursor, source, onRecovery = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    try {
      return await request(cursor);
    } catch (error) {
      if (!error.responseLost) throw error;
      onRecovery();
      // The hosting gateway can lose a slow response after the function saves.
      // Confirm the durable cursor with read-only requests; never replay AI here.
      for (let attempt = 0; attempt < 7; attempt++) {
        if (attempt) await wait(5000);
        let document;
        try { document = await read(); } catch { continue; }
        const progress = document.fact_extraction;
        if (source && progress?.source && source !== progress.source)
          throw Error("This document changed while reading. Reopen it to continue with the current version.");
        if (progress?.next_batch > cursor)
          return { progress, warnings: progress.warnings || [] };
      }
      throw Error("The connection was interrupted and this section could not be confirmed. Your original and earlier sections are saved. Reopen the document to check progress before continuing.");
    }
  }
  return { nextSection };
});
