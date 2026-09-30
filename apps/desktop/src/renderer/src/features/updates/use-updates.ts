import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IpcMethod } from "@mrstreamer/contracts/ipc";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";

type StatusMethod = Extract<IpcMethod, "updates.check" | "updates.download">;

/** The update status and the actions on it. Every action answers with the new status. */
export function useUpdates() {
  const client = useQueryClient();
  const status = useQuery(queries.updates());
  const store = (next: UpdateStatus) => client.setQueryData(queries.updates().queryKey, next);
  const action = useMutation({
    mutationFn: (method: StatusMethod) => call(method),
    onSuccess: store,
  });
  const setChannel = useMutation({
    mutationFn: (channel: Channel) => call("updates.setChannel", { channel }),
    onSuccess: store,
  });
  return {
    status: status.data,
    run: (method: StatusMethod) => action.mutate(method),
    setChannel: (channel: Channel) => setChannel.mutate(channel),
    cancel: () => void call("updates.cancel").catch(() => {}),
  };
}
