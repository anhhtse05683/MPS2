/**
 * Client-side Auth: JWT + Refresh, localStorage
 */
const Auth = {
  KEY_ACCESS: "erp_access_token",
  KEY_REFRESH: "erp_refresh_token",
  KEY_USER: "erp_user",
  KEY_PERMISSIONS: "erp_permissions",

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
  },
  clearSession() {
    localStorage.removeItem(this.KEY_ACCESS);
    localStorage.removeItem(this.KEY_REFRESH);
    localStorage.removeItem(this.KEY_USER);
    localStorage.removeItem(this.KEY_PERMISSIONS);
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
