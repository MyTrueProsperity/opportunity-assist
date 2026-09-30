(function () {
  "use strict";

  var status = document.getElementById("resetStatus");
  var form = document.getElementById("resetForm");
  var button = document.getElementById("resetButton");
  var hash = new URLSearchParams(window.location.hash.slice(1));
  var query = new URLSearchParams(window.location.search);
  var hasRecoveryLink = hash.get("type") === "recovery" && hash.has("access_token");
  var linkError = hash.has("error") || query.has("error");
  var ready = false;
  var finished = false;

  function clearLinkFromAddressBar() {
    window.history.replaceState(null, "", window.location.pathname);
  }

  function showInvalidLink() {
    if (ready || finished) return;
    status.className = "error";
    status.textContent = "This reset link is invalid or has expired. Request a new link from the sign-in page.";
    form.hidden = true;
    clearLinkFromAddressBar();
  }

  if (linkError || !hasRecoveryLink) {
    showInvalidLink();
    return;
  }

  if (!window.supabase || !window.OA_CONFIG) {
    status.className = "error";
    status.textContent = "Password reset is temporarily unavailable. Please try again later.";
    clearLinkFromAddressBar();
    return;
  }

  var sb = window.supabase.createClient(
    window.OA_CONFIG.SUPABASE_URL,
    window.OA_CONFIG.SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, detectSessionInUrl: true } }
  );

  sb.auth.onAuthStateChange(function (event, session) {
    if (event !== "PASSWORD_RECOVERY" || !session || finished) return;
    ready = true;
    status.className = "";
    status.textContent = "Choose a new password with at least 8 characters.";
    form.hidden = false;
    clearLinkFromAddressBar();
  });

  sb.auth.getSession().then(function (result) {
    if (ready || finished) return;
    // Only PASSWORD_RECOVERY can authorize this form, even if another session exists.
    showInvalidLink();
  }).catch(showInvalidLink);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!ready || finished) return;
    var password = document.getElementById("newPassword").value;
    var confirmation = document.getElementById("confirmPassword").value;
    if (password !== confirmation) {
      status.className = "error";
      status.textContent = "The passwords do not match.";
      return;
    }
    if (password.length < 8) {
      status.className = "error";
      status.textContent = "Use at least 8 characters for your new password.";
      return;
    }
    button.disabled = true;
    status.className = "";
    status.textContent = "Updating your password…";
    sb.auth.updateUser({ password: password }).then(function (result) {
      button.disabled = false;
      if (result.error) {
        status.className = "error";
        status.textContent = result.error.message || "We couldn’t update your password. Request a new link and try again.";
        return;
      }
      finished = true;
      ready = false;
      form.hidden = true;
      status.className = "success";
      status.textContent = "Your password has been updated. Return to sign in with your new password.";
    }).catch(function () {
      button.disabled = false;
      status.className = "error";
      status.textContent = "We couldn’t update your password. Please try again.";
    });
  });
})();
