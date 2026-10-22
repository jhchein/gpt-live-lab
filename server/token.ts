export interface AccessTokenResult {
  token: string;
  expiresOnTimestamp: number;
}

export function createAccessTokenProvider(
  acquire: () => Promise<AccessTokenResult>,
  refreshSkewMs = 60_000,
) {
  let cached: AccessTokenResult | undefined;
  let inFlight: Promise<string> | undefined;

  return () => {
    if (cached && cached.expiresOnTimestamp > Date.now() + refreshSkewMs) {
      return Promise.resolve(cached.token);
    }
    if (!inFlight) {
      const pending = acquire().then((value) => {
        if (!value.token || !Number.isFinite(value.expiresOnTimestamp)) {
          throw new Error("Credential returned an invalid access token.");
        }
        cached = value;
        return value.token;
      }).finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
      inFlight = pending;
    }
    return inFlight;
  };
}
