import { GooglePlayMetadataProvider } from "./googleplay";
import { StoreMetadataProvider, StoreProviderError } from "./types";

const providers: StoreMetadataProvider[] = [new GooglePlayMetadataProvider()];

const MAX_URL_LENGTH = 2048;

/**
 * Parse + validate a user-supplied store URL and pick a provider.
 * This is the SSRF gate: only https + a URL a known provider recognizes is
 * accepted. Everything else (localhost, private IPs, example.com, file://,
 * look-alike hosts like play.google.com.evil.tld, …) is rejected here, and
 * providers only ever call their own fixed API host.
 */
export function resolveStoreProvider(rawUrl: string): {
  provider: StoreMetadataProvider;
  url: URL;
} {
  const raw = String(rawUrl ?? "").trim();
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new StoreProviderError("invalid_url", "That doesn't look like a valid URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreProviderError("invalid_url", "That doesn't look like a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new StoreProviderError("unsupported_url", "Only https store links are supported");
  }
  const provider = providers.find((p) => p.canHandle(url));
  if (!provider) {
    throw new StoreProviderError(
      "unsupported_url",
      "Unsupported link — paste a Google Play app URL (play.google.com/store/apps/details?id=…)"
    );
  }
  return { provider, url };
}

/** Look up a provider by its name, for resuming an already-submitted lookup. */
export function providerByName(name: string): StoreMetadataProvider {
  const provider = providers.find((p) => p.provider === name);
  if (!provider) {
    throw new StoreProviderError("provider_error", "The store lookup could not be resumed");
  }
  return provider;
}
