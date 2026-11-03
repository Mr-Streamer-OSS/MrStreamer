import { requireNativeModule } from "expo";

export interface SecretStore {
  read(id: string): Promise<string | null>;
  write(id: string, link: string): Promise<void>;
  remove(id: string): Promise<void>;
}

interface SealedLinks {
  readLink(id: string): Promise<string | null>;
  writeLink(id: string, link: string): Promise<void>;
  removeLink(id: string): Promise<void>;
}

// A separate sealed namespace survives the source registry's credential retention at launch.
export const sealedLinks: SecretStore = {
  read: (id) => requireNativeModule<SealedLinks>("Guide").readLink(id),
  write: (id, link) => requireNativeModule<SealedLinks>("Guide").writeLink(id, link),
  remove: (id) => requireNativeModule<SealedLinks>("Guide").removeLink(id),
};

const loginNames =
  /^(username|user|password|pass|pwd|login|token|access_token|auth|key|apikey|api_key|secret)$/i;

export function playlistSecrets(link: string): string[] {
  const url = new URL(link);

  const username =
    [
      decodeURIComponent(url.username),
      ...[...url.searchParams].flatMap(([key, value]) =>
        /^(username|user|login)$/i.test(key) ? [value] : [],
      ),
    ].find(Boolean) ?? "";

  const secrets = [
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    ...[...url.searchParams].flatMap(([key, value]) => (loginNames.test(key) ? [value] : [])),
  ].filter(Boolean);

  const at = username.length < 16 ? secrets.indexOf(username) : -1;

  return [
    username,
    ...(at < 0 ? secrets : secrets.toSpliced(at, 1)),
    ...playlistUncertain(link).filter((value) => value.length >= 16),
  ];
}

export function playlistUncertain(link: string): string[] {
  return [...new URL(link).searchParams].flatMap(([key, value]) =>
    !loginNames.test(key) && value ? [value] : [],
  );
}
