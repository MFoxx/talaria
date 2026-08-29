/**
 * Public library entry point.
 *
 * The high-level `TalariaClient` (ARCHITECTURE §10) lands in a later phase. For now this
 * re-exports the stable protocol and config contracts that both halves build on.
 */

export const VERSION = '0.1.0';

export * from './protocol/errors.js';
export * from './protocol/messages.js';
export * from './protocol/framing.js';

export * from './config/paths.js';
export * from './config/server-config.js';
export * from './config/client-config.js';

export { TalariaClient, type RunOptions, type AttachOptions } from './client/talaria-client.js';
export {
  Transport,
  remoteConnector,
  sshConnector,
  tailscaleSshConnector,
  buildSshArgs,
  buildTailscaleSshArgs,
  type Connector,
  type Channel,
  type RemoteTarget,
  type OpenSshTarget,
  type SshTarget,
  type TailscaleSshTarget,
} from './client/transport.js';
export { OffsetStore } from './client/offsets.js';
