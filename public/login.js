const themeToggle = document.getElementById("theme-toggle");

function syncThemeIcons() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const sun = themeToggle.querySelector(".icon-sun");
  const moon = themeToggle.querySelector(".icon-moon");
  if (sun) sun.hidden = isDark;
  if (moon) moon.hidden = !isDark;
  themeToggle.title = isDark ? "Mode terang" : "Mode gelap";
  themeToggle.setAttribute("aria-label", themeToggle.title);
}

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    // private mode / storage disabled — the theme still applies for this session
  }
  syncThemeIcons();
});

syncThemeIcons();

document.getElementById("toggle-password").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById("password");
  const eyeOpen = btn.querySelector(".eye-open");
  const eyeOff = btn.querySelector(".eye-off");
  const willShow = input.type === "password";

  input.type = willShow ? "text" : "password";
  if (eyeOpen) eyeOpen.hidden = willShow;
  if (eyeOff) eyeOff.hidden = !willShow;

  const label = willShow ? "Sembunyikan kata sandi" : "Tampilkan kata sandi";
  btn.title = label;
  btn.setAttribute("aria-label", label);
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  errorEl.textContent = "";

  const form = new FormData(e.target);
  const body = {
    username: form.get("username"),
    password: form.get("password"),
  };

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    window.location.href = "/";
  } else {
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || "Nama pengguna atau kata sandi salah";
  }
});
