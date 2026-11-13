// ---------------------------------------------------------------
// Sign in / create account / forgot password / new password / Google One Tap.
// This file only handles the forms. app.js decides which screen to show.
// ---------------------------------------------------------------
import { GOOGLE_CLIENT_ID } from "../config.js";
import { $ } from "../core/state.js";

// Where Supabase sends people back to after OAuth / email links.
// This exact address must be listed under Authentication > URL Configuration > Redirect URLs.
const REDIRECT_URL = window.location.origin + window.location.pathname;

const MESSAGES = {
  invalid_credentials: "Incorrect username/email or password.",
  email_not_confirmed: "Please confirm your email first. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Try signing in instead.",
  weak_password: "Password is too weak. Use at least 8 characters.",
  over_email_send_rate_limit: "Too many emails sent. Please wait a bit and try again.",
  over_request_rate_limit: "Too many attempts. Please wait a bit and try again.",
  validation_failed: "That email address doesn't look right.",
  signup_disabled: "Sign-ups are currently disabled.",
  PGRST202: "Username sign-in isn't set up yet. Run sql/06_username_login.sql in Supabase, then reload.",
  "42883": "Username sign-in isn't set up yet. Run sql/06_username_login.sql in Supabase, then reload.",
  provider_disabled: "That sign-in method isn't enabled yet in Supabase.",
};
const authError = (err) => MESSAGES[err.code] || err.message || "Something went wrong.";

// Supabase returns { data, error } instead of throwing. This turns errors into throws.
function check({ data, error }) {
  if (error) throw error;
  return data;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// onPasswordChanged() is called after the new password is saved.
export function initAuth(supabase, { onPasswordChanged }) {
  const statusEl = $("status");
  const loginForm = $("login-form");
  const registerForm = $("register-form");

  const setStatus = (message, ok = false) => {
    statusEl.textContent = message;
    statusEl.classList.toggle("ok", ok);
  };

  async function run(button, task) {
    setStatus("");
    if (button) button.disabled = true;
    try {
      await task();
    } catch (err) {
      console.error(err);
      setStatus(authError(err));
      if (err.code === "email_not_confirmed") $("resend-btn").classList.remove("hidden");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function showTab(which) {
    const isLogin = which === "login";
    loginForm.classList.toggle("hidden", !isLogin);
    registerForm.classList.toggle("hidden", isLogin);
    $("tab-login").classList.toggle("active", isLogin);
    $("tab-register").classList.toggle("active", !isLogin);
    $("auth-title").textContent = isLogin ? "Welcome back" : "Create your account";
    $("auth-sub").textContent = isLogin ? "Sign in to your account to continue" : "It only takes a minute";
    setStatus("");
  }
  // Show / hide button on every password box
  for (const id of ["login-password", "reg-password", "reg-confirm"]) {
    const input = $(id);
    const wrap = document.createElement("div");
    wrap.className = "pw-wrap";
    input.replaceWith(wrap);
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "pw-toggle";
    eye.textContent = "Show";
    eye.setAttribute("aria-label", "Show or hide password");
    eye.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      eye.textContent = hidden ? "Hide" : "Show";
    });
    wrap.append(input, eye);
  }

  $("tab-login").addEventListener("click", () => showTab("login"));
  $("tab-register").addEventListener("click", () => showTab("register"));

  // Social login: the first use creates the account, so one button covers login and sign-up.
  $("google-btn").addEventListener("click", (e) =>
    run(e.currentTarget, async () =>
      check(await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: REDIRECT_URL } }))
    )
  );
  $("facebook-btn").addEventListener("click", (e) =>
    run(e.currentTarget, async () =>
      check(
        await supabase.auth.signInWithOAuth({
          provider: "facebook",
          options: { redirectTo: REDIRECT_URL, scopes: "email" },
        })
      )
    )
  );

  // "maynard_01" or "me@mail.com" -> the email Supabase signs in with (null if unknown)
  async function resolveEmail(identifier) {
    const id = identifier.trim();
    if (id.includes("@")) return id;
    const { data, error } = await supabase.rpc("login_email", { identifier: id });
    if (error) throw error;
    return data || null;
  }

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const identifier = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!identifier || !password) return setStatus("Enter your username or email, and your password.");
    run(loginForm.querySelector("button[type=submit]"), async () => {
      const email = await resolveEmail(identifier);
      // unknown username: same message as a wrong password
      if (!email) throw { code: "invalid_credentials" };
      check(await supabase.auth.signInWithPassword({ email, password }));
    });
  });

  registerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("reg-name").value.trim();
    const username = $("reg-username").value.trim().toLowerCase();
    const email = $("reg-email").value.trim();
    const password = $("reg-password").value;
    const confirm = $("reg-confirm").value;

    if (!name) return setStatus("Please enter your name.");
    if (!/^[a-z0-9_]{3,30}$/.test(username)) return setStatus("Username: 3-30 characters, letters, numbers or underscore.");
    if (!email.includes("@")) return setStatus("Please enter a valid email address.");
    if (password.length < 8) return setStatus("Password must be at least 8 characters.");
    if (password !== confirm) return setStatus("Passwords don't match.");

    run(registerForm.querySelector("button[type=submit]"), async () => {
      const free = await supabase.rpc("username_available", { uname: username });
      if (free.error) throw free.error;
      if (!free.data) return setStatus("That username is taken. Try another.");
      const data = check(
        await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name, username }, emailRedirectTo: REDIRECT_URL },
        })
      );
      // With email confirmation on, Supabase hides whether an email is taken,
      // but returns a user with no identities when it is.
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        return setStatus("An account with this email already exists. Try signing in instead.");
      }
      if (!data.session) {
        showTab("login");
        $("login-email").value = email;
        setStatus("Account created! Check your email and click the confirmation link.", true);
      }
    });
  });

  $("resend-btn").addEventListener("click", () => {
    const typed = $("login-email").value.trim();
    if (!typed) return setStatus("Type your username or email above first.");
    run(null, async () => {
      const email = await resolveEmail(typed);
      if (!email) return setStatus("No account found with that username.");
      check(await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: REDIRECT_URL } }));
      setStatus("Confirmation email sent. Check your inbox.", true);
    });
  });

  $("forgot-btn").addEventListener("click", () => {
    const typed = $("login-email").value.trim();
    if (!typed) return setStatus("Type your username or email above first, then click 'Forgot password?'.");
    run(null, async () => {
      const email = await resolveEmail(typed);
      if (!email) return setStatus("If that account exists, a reset email is on its way.", true);
      check(await supabase.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT_URL }));
      setStatus("Password reset email sent. Check your inbox.", true);
    });
  });

  // Set a new password (after clicking the reset link in the email)
  $("recovery-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("recovery-status");
    const password = $("new-password").value;
    const confirm = $("new-confirm").value;
    out.classList.remove("ok");
    if (password.length < 8) return (out.textContent = "Password must be at least 8 characters.");
    if (password !== confirm) return (out.textContent = "Passwords don't match.");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      out.textContent = authError(error);
      return;
    }
    out.textContent = "Password updated!";
    out.classList.add("ok");
    setTimeout(onPasswordChanged, 800);
  });

  // Google One Tap: Google needs a hashed nonce; Supabase needs the original (raw) one.
  async function setupOneTap() {
    if (GOOGLE_CLIENT_ID.startsWith("YOUR_")) return; // not configured yet
    if (!window.google?.accounts?.id) return;
    const rawNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const hashedNonce = await sha256Hex(rawNonce);
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce: hashedNonce,
      callback: (response) =>
        run(null, async () =>
          check(await supabase.auth.signInWithIdToken({ provider: "google", token: response.credential, nonce: rawNonce }))
        ),
      auto_select: false,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
    });
    window.google.accounts.id.prompt();
  }

  return {
    offerOneTap() {
      if (document.readyState === "complete") setupOneTap();
      else window.addEventListener("load", setupOneTap, { once: true });
    },
  };
}

// Used by the account menu's "Change password" dialog.
export const passwordProblem = (pw, confirm) =>
  pw.length < 8 ? "Password must be at least 8 characters." : pw !== confirm ? "Passwords don't match." : "";
export { authError };
