import { requireNativeModule } from "expo";

export interface Permission {
  readonly missing: "" | "notifications" | "channel" | "exact";
  readonly failed?: boolean;
  readonly readFailed?: boolean;
  readonly canOpen: boolean;
}

export interface RemindersNative {
  list(): Promise<string>;
  save(json: string): Promise<void>;
  cancel(id: string): Promise<void>;
  reconcile(json: string): Promise<void>;
  recover(): Promise<void>;
  permission(): Promise<Permission>;
  openSetting(kind: string): Promise<void>;
  takeTap(): Promise<string | null>;
  addListener(event: "tap", listener: (event: { json: string }) => void): { remove(): void };
}

export const nativeReminders = () => requireNativeModule<RemindersNative>("ProgrammeReminders");
