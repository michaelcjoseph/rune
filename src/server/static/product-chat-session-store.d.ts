export interface ProductChatSession {
  chatMessages: Array<{ role: string; text: string }>;
  planning: Record<string, unknown>;
  activeOp: Record<string, unknown> | null;
  statusLabel: string | null;
  streamingMessageIndex: number;
  opActivity: Array<Record<string, unknown>>;
  revision: number;
}

export function getProductSession(product: string): ProductChatSession;

export function subscribeProductSessions(
  subscriber: (product: string, frame: Record<string, unknown>) => void,
): () => boolean;

export function reconcileProductSessionOperation(
  product: string,
  state: Record<string, unknown>,
): void;

export function initializeProductChatFrameConsumer(
  targetWindow?: Pick<Window, 'addEventListener'>,
): void;

export function resetProductSessions(): void;
