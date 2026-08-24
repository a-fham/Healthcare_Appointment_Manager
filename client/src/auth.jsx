import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading

  useEffect(() => {
    api
      .get('/api/auth/me')
      .then((d) => setMe(d.user))
      .catch(() => setMe(null));
  }, []);

  const value = {
    me,
    isPatient: me?.role === 'patient',
    isDoctor: me?.role === 'doctor',
    isAdmin: me?.role === 'admin',
    async login(email, password) {
      const d = await api.post('/api/auth/login', { email, password });
      setMe(d.user);
      return d.user;
    },
    async register(payload) {
      return api.post('/api/auth/register', payload);
    },
    async logout() {
      try {
        await api.post('/api/auth/logout');
      } catch {
        /* cookie is cleared server-side or already gone , clear local state regardless */
      }
      setMe(null);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
