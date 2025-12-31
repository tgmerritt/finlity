"""
Event bus system for plugin communication.

Plugins can subscribe to system events and publish their own events
for inter-plugin communication.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Optional
from weakref import WeakSet

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    """System events that plugins can subscribe to."""

    # Application lifecycle
    APP_STARTED = "app_started"
    APP_SHUTDOWN = "app_shutdown"

    # Profile events
    PROFILE_ACTIVATED = "profile_activated"
    PROFILE_CREATED = "profile_created"
    PROFILE_DELETED = "profile_deleted"
    PROFILE_UPDATED = "profile_updated"

    # Position events
    POSITION_ADDED = "position_added"
    POSITION_UPDATED = "position_updated"
    POSITION_DELETED = "position_deleted"

    # Account events
    ACCOUNT_CREATED = "account_created"
    ACCOUNT_UPDATED = "account_updated"
    ACCOUNT_DELETED = "account_deleted"

    # Data events
    PRICES_UPDATED = "prices_updated"
    IMPORT_STARTED = "import_started"
    IMPORT_COMPLETED = "import_completed"
    IMPORT_FAILED = "import_failed"
    SNAPSHOT_CREATED = "snapshot_created"

    # Analysis events
    ANALYSIS_REQUESTED = "analysis_requested"
    ANALYSIS_COMPLETED = "analysis_completed"
    TRIGGER_FIRED = "trigger_fired"

    # Export events
    EXPORT_REQUESTED = "export_requested"
    EXPORT_COMPLETED = "export_completed"

    # Plugin events
    PLUGIN_LOADED = "plugin_loaded"
    PLUGIN_UNLOADED = "plugin_unloaded"
    PLUGIN_ERROR = "plugin_error"

    # Custom events (for plugin-to-plugin communication)
    CUSTOM = "custom"


@dataclass
class Event:
    """An event that can be published through the event bus."""

    event_type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    source: str = ""  # Plugin name or "system"
    timestamp: datetime = field(default_factory=datetime.now)
    custom_type: str = ""  # For CUSTOM events

    def to_dict(self) -> dict:
        return {
            "event_type": self.event_type.value,
            "data": self.data,
            "source": self.source,
            "timestamp": self.timestamp.isoformat(),
            "custom_type": self.custom_type,
        }


# Type for event handlers
EventHandler = Callable[[Event], None]
AsyncEventHandler = Callable[[Event], Any]  # Can be async


@dataclass
class Subscription:
    """A subscription to an event type."""

    event_type: EventType
    handler: EventHandler | AsyncEventHandler
    plugin_name: str = ""
    custom_type: str = ""  # For filtering CUSTOM events
    priority: int = 0  # Higher priority handlers run first
    is_async: bool = False


class EventBus:
    """
    Central event bus for the plugin system.

    Allows plugins to subscribe to events and publish their own events.
    Supports both synchronous and asynchronous handlers.
    """

    def __init__(self):
        self._subscriptions: dict[EventType, list[Subscription]] = {}
        self._event_history: list[Event] = []
        self._max_history: int = 100
        self._paused: bool = False

    def subscribe(
        self,
        event_type: EventType,
        handler: EventHandler | AsyncEventHandler,
        plugin_name: str = "",
        custom_type: str = "",
        priority: int = 0,
    ) -> Subscription:
        """
        Subscribe to an event type.

        Args:
            event_type: The type of event to subscribe to
            handler: Function to call when event is published
            plugin_name: Name of the subscribing plugin (for tracking)
            custom_type: For CUSTOM events, filter by this custom type
            priority: Higher priority handlers run first (default 0)

        Returns:
            Subscription object that can be used to unsubscribe
        """
        # Determine if handler is async
        is_async = asyncio.iscoroutinefunction(handler)

        subscription = Subscription(
            event_type=event_type,
            handler=handler,
            plugin_name=plugin_name,
            custom_type=custom_type,
            priority=priority,
            is_async=is_async,
        )

        if event_type not in self._subscriptions:
            self._subscriptions[event_type] = []

        self._subscriptions[event_type].append(subscription)

        # Sort by priority (higher first)
        self._subscriptions[event_type].sort(key=lambda s: -s.priority)

        logger.debug(
            f"Plugin '{plugin_name}' subscribed to {event_type.value}"
            + (f" (custom: {custom_type})" if custom_type else "")
        )

        return subscription

    def unsubscribe(self, subscription: Subscription) -> bool:
        """
        Unsubscribe from an event type.

        Args:
            subscription: The subscription to remove

        Returns:
            True if subscription was found and removed
        """
        if subscription.event_type in self._subscriptions:
            try:
                self._subscriptions[subscription.event_type].remove(subscription)
                logger.debug(
                    f"Plugin '{subscription.plugin_name}' unsubscribed from "
                    f"{subscription.event_type.value}"
                )
                return True
            except ValueError:
                pass
        return False

    def unsubscribe_all(self, plugin_name: str) -> int:
        """
        Unsubscribe all handlers for a plugin.

        Args:
            plugin_name: Name of the plugin to unsubscribe

        Returns:
            Number of subscriptions removed
        """
        count = 0
        for event_type in self._subscriptions:
            original_len = len(self._subscriptions[event_type])
            self._subscriptions[event_type] = [
                s for s in self._subscriptions[event_type] if s.plugin_name != plugin_name
            ]
            count += original_len - len(self._subscriptions[event_type])

        if count > 0:
            logger.debug(f"Removed {count} subscriptions for plugin '{plugin_name}'")

        return count

    def publish(self, event: Event) -> None:
        """
        Publish an event synchronously.

        Calls all subscribed handlers in priority order.
        Async handlers are scheduled but not awaited.

        Args:
            event: The event to publish
        """
        if self._paused:
            logger.debug(f"Event bus paused, dropping event: {event.event_type.value}")
            return

        # Add to history
        self._event_history.append(event)
        if len(self._event_history) > self._max_history:
            self._event_history.pop(0)

        # Get subscriptions for this event type
        subscriptions = self._subscriptions.get(event.event_type, [])

        logger.debug(
            f"Publishing {event.event_type.value} from '{event.source}' "
            f"to {len(subscriptions)} subscribers"
        )

        for sub in subscriptions:
            # Filter CUSTOM events by custom_type
            if event.event_type == EventType.CUSTOM:
                if sub.custom_type and sub.custom_type != event.custom_type:
                    continue

            try:
                if sub.is_async:
                    # Schedule async handler
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(sub.handler(event))
                    except RuntimeError:
                        # No running loop, skip async handler
                        logger.warning(
                            f"Skipping async handler for {sub.plugin_name}: "
                            "no running event loop"
                        )
                else:
                    sub.handler(event)
            except Exception as e:
                logger.error(
                    f"Error in event handler for {sub.plugin_name}: {e}",
                    exc_info=True,
                )

    async def publish_async(self, event: Event) -> None:
        """
        Publish an event asynchronously.

        Awaits all handlers, both sync and async.

        Args:
            event: The event to publish
        """
        if self._paused:
            logger.debug(f"Event bus paused, dropping event: {event.event_type.value}")
            return

        # Add to history
        self._event_history.append(event)
        if len(self._event_history) > self._max_history:
            self._event_history.pop(0)

        subscriptions = self._subscriptions.get(event.event_type, [])

        logger.debug(
            f"Publishing async {event.event_type.value} from '{event.source}' "
            f"to {len(subscriptions)} subscribers"
        )

        for sub in subscriptions:
            if event.event_type == EventType.CUSTOM:
                if sub.custom_type and sub.custom_type != event.custom_type:
                    continue

            try:
                if sub.is_async:
                    await sub.handler(event)
                else:
                    sub.handler(event)
            except Exception as e:
                logger.error(
                    f"Error in event handler for {sub.plugin_name}: {e}",
                    exc_info=True,
                )

    def publish_custom(
        self,
        custom_type: str,
        data: dict[str, Any],
        source: str = "",
    ) -> None:
        """
        Convenience method to publish a custom event.

        Args:
            custom_type: The custom event type identifier
            data: Event data
            source: Source plugin name
        """
        event = Event(
            event_type=EventType.CUSTOM,
            custom_type=custom_type,
            data=data,
            source=source,
        )
        self.publish(event)

    def pause(self) -> None:
        """Pause event delivery (events will be dropped)."""
        self._paused = True
        logger.info("Event bus paused")

    def resume(self) -> None:
        """Resume event delivery."""
        self._paused = False
        logger.info("Event bus resumed")

    def get_history(self, limit: int = 50) -> list[Event]:
        """Get recent event history."""
        return self._event_history[-limit:]

    def get_subscriptions(self, event_type: Optional[EventType] = None) -> dict:
        """Get current subscriptions, optionally filtered by event type."""
        if event_type:
            subs = self._subscriptions.get(event_type, [])
            return {
                event_type.value: [
                    {"plugin": s.plugin_name, "priority": s.priority}
                    for s in subs
                ]
            }

        return {
            et.value: [
                {"plugin": s.plugin_name, "priority": s.priority}
                for s in subs
            ]
            for et, subs in self._subscriptions.items()
            if subs
        }

    def clear(self) -> None:
        """Clear all subscriptions and history."""
        self._subscriptions.clear()
        self._event_history.clear()
        logger.info("Event bus cleared")


# Global event bus instance
_event_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """Get the global event bus instance."""
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus


# Convenience functions for common events
def emit_app_started() -> None:
    """Emit app_started event."""
    get_event_bus().publish(Event(EventType.APP_STARTED, source="system"))


def emit_app_shutdown() -> None:
    """Emit app_shutdown event."""
    get_event_bus().publish(Event(EventType.APP_SHUTDOWN, source="system"))


def emit_profile_activated(profile_id: str, profile_name: str) -> None:
    """Emit profile_activated event."""
    get_event_bus().publish(
        Event(
            EventType.PROFILE_ACTIVATED,
            data={"profile_id": profile_id, "profile_name": profile_name},
            source="system",
        )
    )


def emit_prices_updated(tickers: list[str]) -> None:
    """Emit prices_updated event."""
    get_event_bus().publish(
        Event(
            EventType.PRICES_UPDATED,
            data={"tickers": tickers, "count": len(tickers)},
            source="system",
        )
    )


def emit_import_completed(
    file_name: str, positions_count: int, success: bool, plugin_name: str = ""
) -> None:
    """Emit import_completed event."""
    get_event_bus().publish(
        Event(
            EventType.IMPORT_COMPLETED,
            data={
                "file_name": file_name,
                "positions_count": positions_count,
                "success": success,
                "plugin": plugin_name,
            },
            source=plugin_name or "system",
        )
    )
