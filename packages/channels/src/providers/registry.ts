import type { ChannelProviderId } from "@orc/core/channels";
import type { ChannelProvider, TransportFactory } from "./base.js";
import { slack } from "./slack.js";
import { slackUser } from "./slack-user.js";
import { telegram } from "./telegram.js";

const providers: Record<ChannelProviderId, ChannelProvider> = {
  telegram,
  slack,
  "slack-user": slackUser,
};

export const channelProviderInfo = Object.values(providers).map((p) => p.info);

export function channelProvider(id: ChannelProviderId): ChannelProvider {
  return providers[id];
}

export const createChannelTransport: TransportFactory = (connection, credentials, state) =>
  providers[connection.provider].transport(connection, credentials, state);
