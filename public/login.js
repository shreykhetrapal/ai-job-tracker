const form = document.querySelector("#loginForm");
const message = document.querySelector("#loginMessage");
const LOGIN_REQUEST_TIMEOUT_MS = 15000;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Signing in...";
  message.textContent = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGIN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Sign in failed.");
    window.location.href = "/";
  } catch (error) {
    message.textContent = error?.name === "AbortError"
      ? "Sign in timed out. Please try again."
      : error.message;
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
    button.textContent = "Sign in";
  }
});
