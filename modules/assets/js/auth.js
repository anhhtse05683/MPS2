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
