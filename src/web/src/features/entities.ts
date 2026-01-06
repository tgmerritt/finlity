/**
 * Entity management feature module.
 * Handles loading, selecting, and managing entities for multi-person household tracking.
 */

import { apiCall } from '@/api/client';
import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import { loadRetirementMetrics } from '@/pages/dashboard';
import type { Entity } from '@/types/api';

/**
 * Load entities from the API and populate the entity selector.
 */
export async function loadEntities(): Promise<void> {
  try {
    const entities = await apiCall<Entity[]>('/api/entities/');
    store.set('entities', entities);
    populateEntitySelector(entities);
  } catch (error) {
    console.error('Error loading entities:', error);
    // Don't show error toast - entities are optional
  }
}

/**
 * Populate the entity selector dropdown with available entities.
 */
function populateEntitySelector(entities: Entity[]): void {
  const selector = document.getElementById('entity-selector') as HTMLSelectElement;
  if (!selector) return;

  // Preserve current selection
  const currentEntityId = store.get('currentEntityId');

  // Clear existing options
  while (selector.firstChild) {
    selector.removeChild(selector.firstChild);
  }

  // Add default "Household (All)" option
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Household (All)';
  selector.appendChild(defaultOption);

  // Add entity options
  for (const entity of entities) {
    // Skip household entity as it's already the default "All" option
    if (entity.is_household) continue;

    const option = document.createElement('option');
    option.value = entity.id;
    option.textContent = entity.name;
    option.style.color = entity.color;

    if (entity.id === currentEntityId) {
      option.selected = true;
    }

    selector.appendChild(option);
  }

  // Update color indicator if we have a selection
  updateEntitySelectorStyle(currentEntityId);
}

/**
 * Update the entity selector style based on selected entity.
 */
function updateEntitySelectorStyle(entityId: string | null): void {
  const selector = document.getElementById('entity-selector') as HTMLSelectElement;
  if (!selector) return;

  if (entityId) {
    const entities = store.get('entities');
    const entity = entities.find((e) => e.id === entityId);
    if (entity) {
      selector.style.borderColor = entity.color;
    }
  } else {
    selector.style.borderColor = '';
  }
}

/**
 * Change the current entity filter.
 * Updates state, persists to localStorage, and reloads retirement metrics.
 */
export async function changeEntity(entityId: string): Promise<void> {
  // Handle empty string as null (Household/All)
  const newEntityId = entityId || null;

  // Update store
  store.set('currentEntityId', newEntityId);

  // Persist to localStorage
  if (newEntityId) {
    localStorage.setItem('currentEntityId', newEntityId);
  } else {
    localStorage.removeItem('currentEntityId');
  }

  // Update selector style
  updateEntitySelectorStyle(newEntityId);

  // Reload retirement metrics with new entity filter
  await loadRetirementMetrics();

  // Show toast notification
  const entities = store.get('entities');
  const entity = entities.find((e) => e.id === newEntityId);
  const name = entity ? entity.name : 'Household';
  showToast(`Retirement metrics: ${name}`, 'success');
}

/**
 * Auto-detect entities from existing account names.
 * Creates entities based on name patterns in account names.
 */
export async function autoDetectEntities(): Promise<void> {
  try {
    const result = await apiCall<{
      success: boolean;
      entities_created: string[];
      accounts_assigned: number;
      income_sources_assigned: number;
    }>('/api/entities/auto-detect', { method: 'POST' });

    if (result.entities_created.length > 0) {
      showToast(
        `Created ${result.entities_created.length} entities: ${result.entities_created.join(', ')}`,
        'success'
      );
    } else {
      showToast('No new entities detected from account names', 'info');
    }

    // Reload entities
    await loadEntities();
  } catch (error) {
    console.error('Error auto-detecting entities:', error);
    showToast('Failed to auto-detect entities', 'error');
  }
}

/**
 * Initialize entity selector on page load.
 */
export function initEntitySelector(): void {
  // Load entities
  loadEntities();

  // Restore saved selection from localStorage
  const savedEntityId = localStorage.getItem('currentEntityId');
  if (savedEntityId) {
    store.set('currentEntityId', savedEntityId);
  }
}
