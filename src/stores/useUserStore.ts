import { create } from "zustand";
import { persist } from "zustand/middleware";
import { devTenantId, isIamAuthEnabled } from "@/lib/iam";

interface TokenState { accessToken: string; refreshToken?: string; expiresAt?: number; tokenType?: string }
interface UserInfo { userId: string; userName: string; name: string; tenantId: string; tenants: string[]; companies?: Array<{ companyCode: string; companyName: string }>; isAdmin?: boolean }

const devUser: UserInfo = { userId: "dev-user", userName: "dev-user", name: "Development User", tenantId: devTenantId, tenants: [devTenantId], isAdmin: false };
interface UserStore {
  tokenobj: TokenState | null;
  userInfo: UserInfo | null;
  _hasHydrated: boolean;
  setToken: (token: TokenState) => void;
  setUserInfo: (user: UserInfo) => void;
  clearUserInfo: () => void;
  setHydrated: (value: boolean) => void;
  logout: () => void;
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      tokenobj: null,
      userInfo: isIamAuthEnabled() ? null : devUser,
      _hasHydrated: false,
      setToken: (tokenobj) => set({ tokenobj }),
      setUserInfo: (userInfo) => set({ userInfo }),
      clearUserInfo: () => set({ userInfo: null }),
      setHydrated: (_hasHydrated) => set({ _hasHydrated }),
      logout: () => {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        localStorage.removeItem("token_expires_at");
        set({ tokenobj: null, userInfo: isIamAuthEnabled() ? null : devUser });
      },
    }),
    {
      name: "ontology-studio-user",
      merge: (persisted, current) => {
        if (!isIamAuthEnabled()) return { ...current, tokenobj: null, userInfo: devUser };
        return { ...current, ...(persisted as Partial<UserStore>) };
      },
      onRehydrateStorage: () => (state) => state?.setHydrated(true),
    },
  ),
);
