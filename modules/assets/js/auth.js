/**
 * Client-side Auth: JWT + Refresh, localStorage, idle timeout
 */
const Auth = {
  KEY_ACCESS: "erp_access_token",
  KEY_REFRESH: "erp_refresh_token",
  KEY_USER: "erp_user",
  KEY_PERMISSIONS: "erp_permissions",

  /** Thời gian không hoạt động (ms) trước khi tự động đăng xuất. Mặc định 30 phút. */
  IDLE_TIMEOUT_MS: 30 * 60 * 1000,
  _idleTimerId: null,
  _idleListenersAttached: false,

  getAccessToken() {
    return localStorage.getItem(this.KEY_ACCESS);
  },
  getRefreshToken() {
    return localStorage.getItem(this.KEY_REFRESH);
  },
  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY_USER) || "null");
    } catch {
      return null;
    }
  },
  getPermissions() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY_PERMISSIONS) || "[]");
    } catch {
      return [];
    }
  },
  setSession(data) {
    if (data.accessToken) localStorage.setItem(this.KEY_ACCESS, data.accessToken);
    if (data.refreshToken) localStorage.setItem(this.KEY_REFRESH, data.refreshToken);
    if (data.user) localStorage.setItem(this.KEY_USER, JSON.stringify(data.user));
    if (data.permissions) localStorage.setItem(this.KEY_PERMISSIONS, JSON.stringify(data.permissions));
    this.startIdleTimer();
  },
  clearSession() {
    this.clearIdleTimer();
    localStorage.removeItem(this.KEY_ACCESS);
    localStorage.removeItem(this.KEY_REFRESH);
    localStorage.removeItem(this.KEY_USER);
    localStorage.removeItem(this.KEY_PERMISSIONS);
  },

  startIdleTimer() {
    if (!this.isLoggedIn()) return;
    if (typeof window !== "undefined" && window.location?.pathname?.indexOf("/modules/Login") !== -1) return;
    this.clearIdleTimer();
    this._idleTimerId = setTimeout(() => {
      this._idleTimerId = null;
      this.onIdle();
    }, this.IDLE_TIMEOUT_MS);
  },
  clearIdleTimer() {
    if (this._idleTimerId) {
      clearTimeout(this._idleTimerId);
      this._idleTimerId = null;
    }
  },
  resetIdleTimer() {
    if (this.isLoggedIn()) this.startIdleTimer();
  },
  onIdle() {
    this.clearSession();
    const path = typeof window !== "undefined" ? window.location?.pathname || "" : "";
    if (path.indexOf("/modules/Login") === -1) {
      const url = window.location.href;
      window.location.href = "/modules/Login/index.html?redirect=" + encodeURIComponent(url) + "&reason=idle";
    }
  },
  initIdleTimer() {
    if (this._idleListenersAttached) return;
    this._idleListenersAttached = true;
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    const reset = () => this.resetIdleTimer();
    events.forEach((ev) => document.addEventListener(ev, reset, { passive: true }));
    if (this.isLoggedIn() && window.location?.pathname?.indexOf("/modules/Login") === -1) {
      this.startIdleTimer();
    }
  },
  isLoggedIn() {
    return !!this.getAccessToken();
  },
  hasPermission(code) {
    const perms = this.getPermissions();
    return perms.includes(code) || perms.includes("admin");
  },

  async refreshAccessToken() {
    const refresh = this.getRefreshToken();
    if (!refresh) return false;
    try {
      const res = await _nativeFetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem(this.KEY_ACCESS, data.accessToken);
      return true;
    } catch {
      return false;
    }
  },

  async fetchWithAuth(url, options = {}) {
    let token = this.getAccessToken();
    if (!token) {
      const refreshed = await this.refreshAccessToken();
      token = refreshed ? this.getAccessToken() : null;
    }
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await _nativeFetch(url, { ...options, headers });
    if (res.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.fetchWithAuth(url, options);
      }
      this.clearSession();
      if (window.location.pathname.indexOf("/modules/Login") === -1) {
        window.location.href = "/modules/Login/index.html?redirect=" + encodeURIComponent(window.location.href);
      }
      throw new Error("Unauthorized");
    }
    return res;
  },
};

// Wrap fetch for /api/* to add auth (use _nativeFetch inside to avoid recursion)
const _nativeFetch = window.fetch;
window.fetch = function (url, options = {}) {
  const urlStr = typeof url === "string" ? url : url?.url || "";
  if (urlStr.startsWith("/api/") && !urlStr.startsWith("/api/auth/login") && !urlStr.startsWith("/api/auth/refresh")) {
    return Auth.fetchWithAuth(url, options);
  }
  return _nativeFetch(url, options);
};

window.Auth = Auth;

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => Auth.initIdleTimer());
  } else {
    Auth.initIdleTimer();
  }
}

// Override alert: hiển thị "Hệ Thống" thay vì origin (localhost/IP)
(function () {
  const TITLE = "Hệ Thống";
  window.alert = function (msg) {
    const s = String(msg ?? "");
    const wrap = document.createElement("div");
    wrap.id = "sysAlertWrap";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "sysAlertTitle");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);font-family:system-ui,sans-serif";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#fff;border-radius:8px;padding:1.25rem 1.5rem;min-width:280px;max-width:90vw;box-shadow:0 4px 24px rgba(0,0,0,0.2)";
    box.innerHTML =
      '<div id="sysAlertTitle" style="font-weight:600;margin-bottom:0.75rem;font-size:1rem">' +
      TITLE +
      '</div><div class="sysAlertMsg" style="margin-bottom:1rem;white-space:pre-wrap;word-break:break-word"></div><button type="button" class="btn btn-primary" id="sysAlertOk">OK</button>';
    const msgEl = box.querySelector(".sysAlertMsg");
    msgEl.textContent = s;
    wrap.appendChild(box);
    const close = () => wrap.remove();
    box.querySelector("#sysAlertOk").onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    document.body.appendChild(wrap);
  };
})();
