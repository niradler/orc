import type { PushTopic } from "@orc/core/push";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/api/client";
import {
  createPushSubscription,
  currentPushSubscription,
  pushSupport,
  toSubscriptionInput,
} from "@/lib/pwa";

const DEVICES_KEY = ["push", "devices"];
const THIS_DEVICE_KEY = ["push", "this-device"];

async function registerThisDevice() {
  const subscription = await currentPushSubscription();
  if (!subscription || Notification.permission !== "granted") return null;
  return api.push.subscribe(toSubscriptionInput(subscription));
}

export function usePushDevices() {
  return useQuery({ queryKey: DEVICES_KEY, queryFn: api.push.devices });
}

/** The server record for this browser's subscription, re-registered so rotated endpoints heal. */
export function useThisPushDevice() {
  return useQuery({
    queryKey: THIS_DEVICE_KEY,
    queryFn: registerThisDevice,
    enabled: pushSupport() === "supported",
  });
}

function useInvalidatePush() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["push"] });
}

export function useEnablePush() {
  const invalidate = useInvalidatePush();
  return useMutation({
    mutationFn: async () => {
      const { public_key } = await api.push.config();
      const subscription = await createPushSubscription(public_key);
      return api.push.subscribe(toSubscriptionInput(subscription));
    },
    onSuccess: invalidate,
  });
}

export function useDisablePush() {
  const invalidate = useInvalidatePush();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      await (await currentPushSubscription())?.unsubscribe();
      await api.push.remove(deviceId);
    },
    onSuccess: invalidate,
  });
}

export function useRemovePushDevice() {
  const invalidate = useInvalidatePush();
  return useMutation({ mutationFn: api.push.remove, onSuccess: invalidate });
}

export function useUpdatePushTopics() {
  const invalidate = useInvalidatePush();
  return useMutation({
    mutationFn: ({ id, topics }: { id: string; topics: PushTopic[] }) =>
      api.push.updateTopics(id, topics),
    onSuccess: invalidate,
  });
}

export function useTestPush() {
  const invalidate = useInvalidatePush();
  return useMutation({ mutationFn: api.push.test, onSuccess: invalidate });
}

/** Re-registers an existing subscription once per app load, after the API session is ready. */
export function usePushResync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (pushSupport() !== "supported") return;
    void queryClient.prefetchQuery({
      queryKey: THIS_DEVICE_KEY,
      queryFn: registerThisDevice,
    });
  }, [queryClient]);
}
