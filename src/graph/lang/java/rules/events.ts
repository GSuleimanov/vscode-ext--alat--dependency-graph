import { RoleRule } from '../../registry';
import { Tags } from '../../../core/tags';

// Method-level listener annotations that make a class an event handler. Covers
// Spring application events, Guava/EventBus, and the common messaging listeners.
const LISTENER_ANNOTATIONS = new Set([
  'EventListener', 'TransactionalEventListener', 'Subscribe', 'EventHandler',
  'KafkaListener', 'RabbitListener', 'JmsListener', 'StreamListener', 'SqsListener',
]);

export const eventHandlerRule: RoleRule = {
  id: 'java/events',
  enabled: () => true,
  tags(type) {
    const members = type.memberAnnotations ?? [];
    return members.some(a => LISTENER_ANNOTATIONS.has(a)) ? [Tags.EventHandler] : [];
  },
};
