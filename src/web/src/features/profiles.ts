/**
 * Profile management feature module.
 * Handles profile CRUD, switching, import/export.
 */

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { showLoading, hideLoading } from '@/ui/loading';
import { store } from '@/state/store';
import { emit } from '@/state/events';
import { refreshData } from '@/pages/dashboard';
import { clearCommentaryCache } from '@/features/commentary';
import { showTab } from '@/ui/tabs';
import type { Profile } from '@/types/api';

/** Current active profile ID. */
let currentProfileId: string | null = null;

/** Available profiles list. */
let availableProfiles: Profile[] = [];

/**
 * Create SVG icon element for profile.
 * @param iconName - Icon identifier
 * @returns SVG element
 */
function createIconSvg(iconName: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');

  switch (iconName) {
    case 'user': {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '7');
      circle.setAttribute('r', '4');
      svg.appendChild(path);
      svg.appendChild(circle);
      break;
    }
    case 'users': {
      const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path1.setAttribute('d', 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '9');
      circle.setAttribute('cy', '7');
      circle.setAttribute('r', '4');
      const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('d', 'M23 21v-2a4 4 0 0 0-3-3.87');
      const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path3.setAttribute('d', 'M16 3.13a4 4 0 0 1 0 7.75');
      svg.appendChild(path1);
      svg.appendChild(circle);
      svg.appendChild(path2);
      svg.appendChild(path3);
      break;
    }
    case 'briefcase': {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '2');
      rect.setAttribute('y', '7');
      rect.setAttribute('width', '20');
      rect.setAttribute('height', '14');
      rect.setAttribute('rx', '2');
      rect.setAttribute('ry', '2');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16');
      svg.appendChild(rect);
      svg.appendChild(path);
      break;
    }
    case 'building': {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '4');
      rect.setAttribute('y', '2');
      rect.setAttribute('width', '16');
      rect.setAttribute('height', '20');
      rect.setAttribute('rx', '2');
      rect.setAttribute('ry', '2');
      const lines = [
        ['9', '6', '9', '6.01'],
        ['15', '6', '15', '6.01'],
        ['9', '10', '9', '10.01'],
        ['15', '10', '15', '10.01'],
        ['9', '14', '9', '14.01'],
        ['15', '14', '15', '14.01'],
        ['9', '18', '15', '18'],
      ];
      svg.appendChild(rect);
      lines.forEach((coords) => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', coords[0] ?? '0');
        line.setAttribute('y1', coords[1] ?? '0');
        line.setAttribute('x2', coords[2] ?? '0');
        line.setAttribute('y2', coords[3] ?? '0');
        svg.appendChild(line);
      });
      break;
    }
    case 'star': {
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute(
        'points',
        '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2'
      );
      svg.appendChild(polygon);
      break;
    }
    case 'shield': {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
      svg.appendChild(path);
      break;
    }
    default: {
      // Default to user icon
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '7');
      circle.setAttribute('r', '4');
      svg.appendChild(path);
      svg.appendChild(circle);
    }
  }

  return svg;
}

/**
 * Load profiles from API.
 */
export async function loadProfiles(): Promise<void> {
  try {
    const profiles = await apiCall<Profile[]>('/api/profiles');
    availableProfiles = profiles || [];
    store.set('profiles', availableProfiles);

    // Find active profile
    const activeProfile = profiles?.find((p) => p.is_active);
    if (activeProfile) {
      currentProfileId = activeProfile.id;
      updateProfileDisplay(activeProfile);
    }

    // Update dropdown list
    renderProfileDropdown(profiles || []);
  } catch (error) {
    console.error('Error loading profiles:', error);
  }
}

/**
 * Update profile display in header.
 */
export function updateProfileDisplay(profile: Profile): void {
  const nameEl = document.getElementById('current-profile-name');
  const dotEl = document.getElementById('profile-color-dot');

  if (nameEl) nameEl.textContent = profile.name;
  if (dotEl) dotEl.style.backgroundColor = profile.color;
}

/**
 * Render profile dropdown list.
 */
export function renderProfileDropdown(profiles: Profile[]): void {
  const listEl = document.getElementById('profile-list');
  if (!listEl) return;

  listEl.textContent = '';

  profiles.forEach((profile) => {
    const item = document.createElement('div');
    item.className = 'profile-item' + (profile.is_active ? ' active' : '');
    item.addEventListener('click', () => switchProfile(profile.id));

    const dot = document.createElement('span');
    dot.className = 'profile-color-dot';
    dot.style.backgroundColor = profile.color;

    const name = document.createElement('span');
    name.className = 'profile-item-name';
    name.textContent = profile.name;

    const check = document.createElement('span');
    check.className = 'profile-item-check';
    check.textContent = '\u2713';

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(check);
    listEl.appendChild(item);
  });
}

/**
 * Toggle profile dropdown visibility.
 */
export function toggleProfileDropdown(): void {
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) {
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';

    // Close dropdown when clicking outside
    if (!isVisible) {
      setTimeout(() => {
        document.addEventListener('click', closeProfileDropdownOnClickOutside);
      }, 0);
    }
  }
}

/**
 * Close profile dropdown when clicking outside.
 */
function closeProfileDropdownOnClickOutside(event: MouseEvent): void {
  const dropdown = document.getElementById('profile-dropdown');
  const btn = document.getElementById('profile-selector-btn');
  const target = event.target as Node;

  if (dropdown && btn && !dropdown.contains(target) && !btn.contains(target)) {
    dropdown.style.display = 'none';
    document.removeEventListener('click', closeProfileDropdownOnClickOutside);
  }
}

/**
 * Switch to a different profile.
 */
export async function switchProfile(profileId: string): Promise<void> {
  if (profileId === currentProfileId) {
    toggleProfileDropdown();
    return;
  }

  showLoading('Switching profile...');

  try {
    const profile = await apiCall<Profile>(`/api/profiles/${profileId}/activate`, {
      method: 'POST',
    });

    if (profile) {
      currentProfileId = profile.id;
      updateProfileDisplay(profile);

      // Update dropdown to reflect new active profile
      await loadProfiles();

      // Close dropdown
      const dropdown = document.getElementById('profile-dropdown');
      if (dropdown) dropdown.style.display = 'none';

      showToast(`Switched to profile: ${profile.name}`, 'success');

      // Clear AI commentary cache when switching databases
      clearCommentaryCache();

      // Notify the typed bus before refresh so subscribers can do per-profile
      // setup that needs to run before data lands. `refreshData()` is called
      // unconditionally below so we deliberately do NOT add a subscriber that
      // also calls refreshData — that would double-fetch.
      emit({ type: 'profile:switched', profileId: profile.id });

      // Reload all data for new profile
      await refreshData();
    }
  } catch (error) {
    console.error('Error switching profile:', error);
    showToast('Failed to switch profile', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Show manage profiles modal (navigates to settings).
 */
export function showManageProfilesModal(): void {
  // Close dropdown first
  const dropdown = document.getElementById('profile-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  // Navigate to settings tab and scroll to profiles section
  showTab('settings');
  setTimeout(() => {
    const profilesSection = document.getElementById('profiles-management-list');
    if (profilesSection) {
      profilesSection.scrollIntoView({ behavior: 'smooth' });
    }
  }, 100);
}

/**
 * Load profiles for settings page management list.
 */
export async function loadProfilesForSettings(): Promise<void> {
  try {
    const profiles = await apiCall<Profile[]>('/api/profiles');
    renderProfilesManagementList(profiles || []);
  } catch (error) {
    console.error('Error loading profiles for settings:', error);
  }
}

/**
 * Render profiles management list in settings.
 */
export function renderProfilesManagementList(profiles: Profile[]): void {
  const container = document.getElementById('profiles-management-list');
  if (!container) return;

  container.textContent = '';

  if (!profiles || profiles.length === 0) {
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent = 'No profiles found. Create one to get started.';
    container.appendChild(p);
    return;
  }

  profiles.forEach((profile) => {
    const card = document.createElement('div');
    card.className = 'profile-management-card' + (profile.is_active ? ' active' : '');

    // Icon
    const iconDiv = document.createElement('div');
    iconDiv.className = 'profile-card-icon';
    iconDiv.style.backgroundColor = profile.color;
    iconDiv.appendChild(createIconSvg(profile.icon || 'user'));

    // Info
    const infoDiv = document.createElement('div');
    infoDiv.className = 'profile-card-info';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'profile-card-name';
    nameDiv.textContent = profile.name + ' ';
    if (profile.is_active) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-success';
      badge.textContent = 'Active';
      nameDiv.appendChild(badge);
    }

    const descDiv = document.createElement('div');
    descDiv.className = 'profile-card-description';
    descDiv.textContent = profile.description || 'No description';

    const statsDiv = document.createElement('div');
    statsDiv.className = 'profile-card-stats';
    const lastAccessed = profile.last_accessed
      ? new Date(profile.last_accessed).toLocaleDateString()
      : 'Never';
    statsDiv.textContent = `Last accessed: ${lastAccessed}`;

    infoDiv.appendChild(nameDiv);
    infoDiv.appendChild(descDiv);
    infoDiv.appendChild(statsDiv);

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'profile-card-actions';

    if (!profile.is_active) {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn btn-sm btn-primary';
      activateBtn.textContent = 'Activate';
      activateBtn.title = 'Activate';
      activateBtn.addEventListener('click', () => activateProfile(profile.id));
      actionsDiv.appendChild(activateBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-default';
    editBtn.textContent = 'Edit';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => editProfile(profile.id));

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn btn-sm btn-default';
    exportBtn.textContent = 'Export';
    exportBtn.title = 'Export';
    exportBtn.addEventListener('click', () => exportProfile(profile.id));

    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'btn btn-sm btn-default';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.title = 'Duplicate';
    duplicateBtn.addEventListener('click', () => duplicateProfile(profile.id));

    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(exportBtn);
    actionsDiv.appendChild(duplicateBtn);

    if (!profile.is_active && profiles.length > 1) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', () => deleteProfile(profile.id));
      actionsDiv.appendChild(deleteBtn);
    }

    card.appendChild(iconDiv);
    card.appendChild(infoDiv);
    card.appendChild(actionsDiv);
    container.appendChild(card);
  });
}

/**
 * Show create profile modal.
 */
export function showCreateProfileModal(): void {
  const titleEl = document.getElementById('profile-modal-title');
  const idEl = document.getElementById('profile-id') as HTMLInputElement | null;
  const nameEl = document.getElementById('profile-name') as HTMLInputElement | null;
  const descEl = document.getElementById('profile-description') as HTMLTextAreaElement | null;

  if (titleEl) titleEl.textContent = 'Create Profile';
  if (idEl) idEl.value = '';
  if (nameEl) nameEl.value = '';
  if (descEl) descEl.value = '';

  // Reset color and icon to defaults
  const colorRadios = document.querySelectorAll<HTMLInputElement>('input[name="profile-color"]');
  colorRadios.forEach((r, i) => {
    r.checked = i === 0;
  });

  const iconRadios = document.querySelectorAll<HTMLInputElement>('input[name="profile-icon"]');
  iconRadios.forEach((r, i) => {
    r.checked = i === 0;
  });

  const modal = document.getElementById('profile-modal');
  if (modal) {
    // Remove the `hidden` class (`display:none !important`) — an inline style
    // alone can't override it.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Hide profile modal.
 */
export function hideProfileModal(): void {
  const modal = document.getElementById('profile-modal');
  if (modal) modal.style.display = 'none';
}

/**
 * Edit existing profile.
 */
export async function editProfile(profileId: string): Promise<void> {
  try {
    const profile = await apiCall<Profile>(`/api/profiles/${profileId}`);
    if (!profile) throw new Error('Profile not found');

    const titleEl = document.getElementById('profile-modal-title');
    const idEl = document.getElementById('profile-id') as HTMLInputElement | null;
    const nameEl = document.getElementById('profile-name') as HTMLInputElement | null;
    const descEl = document.getElementById('profile-description') as HTMLTextAreaElement | null;

    if (titleEl) titleEl.textContent = 'Edit Profile';
    if (idEl) idEl.value = profile.id;
    if (nameEl) nameEl.value = profile.name;
    if (descEl) descEl.value = profile.description || '';

    // Set color
    const colorRadios = document.querySelectorAll<HTMLInputElement>('input[name="profile-color"]');
    colorRadios.forEach((r) => {
      r.checked = r.value === profile.color;
    });

    // Set icon
    const iconRadios = document.querySelectorAll<HTMLInputElement>('input[name="profile-icon"]');
    iconRadios.forEach((r) => {
      r.checked = r.value === profile.icon;
    });

    const modal = document.getElementById('profile-modal');
    if (modal) {
    // Remove the `hidden` class (`display:none !important`) — an inline style
    // alone can't override it.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
  } catch (error) {
    console.error('Error loading profile:', error);
    showToast('Failed to load profile', 'error');
  }
}

/**
 * Save profile (create or update).
 */
export async function saveProfile(event: Event): Promise<void> {
  event.preventDefault();

  const profileId = (document.getElementById('profile-id') as HTMLInputElement | null)?.value;
    const name = (document.getElementById('profile-name') as HTMLInputElement | null)?.value?.trim();
    const description = (document.getElementById('profile-description') as HTMLTextAreaElement | null)?.value?.trim();
    const color = (document.querySelector('input[name="profile-color"]:checked') as HTMLInputElement | null)?.value;
    const icon = (document.querySelector('input[name="profile-icon"]:checked') as HTMLInputElement | null)?.value;
  
    if (!name) {
    showToast('Profile name is required', 'error');
    return;
  }

  try {
    if (profileId) {
      // Update existing profile
      await apiCall(`/api/profiles/${profileId}`, {
        method: 'PUT',
        body: { name, description, color, icon },
      });
    } else {
      // Create new profile
      await apiCall('/api/profiles', {
        method: 'POST',
        body: { name, description, color, icon },
      });
    }

    hideProfileModal();
    showToast(profileId ? 'Profile updated' : 'Profile created', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error saving profile:', error);
    showToast((error as Error).message, 'error');
  }
}

/**
 * Activate a profile.
 */
export async function activateProfile(profileId: string): Promise<void> {
  try {
    await apiCall(`/api/profiles/${profileId}/activate`, { method: 'POST' });

    showToast('Profile activated. Reloading...', 'success');

    // Reload everything to use new database
    await loadProfiles();
    await loadProfilesForSettings();
    await refreshData();
  } catch (error) {
    console.error('Error activating profile:', error);
    showToast('Failed to activate profile', 'error');
  }
}

/**
 * Delete a profile.
 */
export async function deleteProfile(profileId: string): Promise<void> {
  if (
    !confirm(
      'Are you sure you want to delete this profile? This will permanently delete all data in this profile and cannot be undone.'
    )
  ) {
    return;
  }

  try {
    await apiCall(`/api/profiles/${profileId}`, { method: 'DELETE' });

    showToast('Profile deleted', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error deleting profile:', error);
    showToast((error as Error).message, 'error');
  }
}

/**
 * Duplicate a profile.
 */
export async function duplicateProfile(profileId: string): Promise<void> {
  const newName = prompt('Enter name for the duplicate profile:');
  if (!newName) return;

  try {
    await apiCall(`/api/profiles/${profileId}/duplicate`, {
      method: 'POST',
      body: { new_name: newName },
    });

    showToast('Profile duplicated', 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error duplicating profile:', error);
    showToast((error as Error).message, 'error');
  }
}

/**
 * Export a profile.
 */
export async function exportProfile(profileId: string): Promise<void> {
  try {
    showToast('Preparing export...', 'info');
    const response = await fetch(`/api/profiles/${profileId}/export`, {
      credentials: 'include',
    });

    if (!response.ok) throw new Error('Failed to export profile');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Get filename from Content-Disposition header or use default
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'profile-export.zip';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    showToast('Profile exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting profile:', error);
    showToast('Failed to export profile', 'error');
  }
}

/**
 * Trigger file input for profile import.
 */
export function importProfileFromFile(): void {
  const input = document.getElementById('profile-import-input') as HTMLInputElement | null;
  if (input) input.click();
}

/**
 * Handle profile import file selection.
 */
export async function handleProfileImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast('Importing profile...', 'info');
    const response = await fetch('/api/profiles/import', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to import profile');
    }

    const result = await response.json();
    showToast(`Profile "${result.name}" imported successfully`, 'success');
    await loadProfiles();
    await loadProfilesForSettings();
  } catch (error) {
    console.error('Error importing profile:', error);
    showToast((error as Error).message, 'error');
  }

  // Reset the input
  input.value = '';
}

/**
 * Get current profile ID.
 */
export function getCurrentProfileId(): string | null {
  return currentProfileId;
}

/**
 * Initialize profiles feature.
 */
export function initProfiles(): void {
  // Profile selector button
  const selectorBtn = document.getElementById('profile-selector-btn');
  if (selectorBtn) {
    selectorBtn.addEventListener('click', toggleProfileDropdown);
  }

  // Manage profiles link
  const manageLink = document.getElementById('manage-profiles-link');
  if (manageLink) {
    manageLink.addEventListener('click', (e) => {
      e.preventDefault();
      showManageProfilesModal();
    });
  }

  // Create profile button
  const createBtn = document.getElementById('create-profile-btn');
  if (createBtn) {
    createBtn.addEventListener('click', showCreateProfileModal);
  }

  // Profile form
  const profileForm = document.getElementById('profile-form');
  if (profileForm) {
    profileForm.addEventListener('submit', saveProfile);
  }

  // Profile modal close
  const modalClose = document.getElementById('profile-modal-close');
  if (modalClose) {
    modalClose.addEventListener('click', hideProfileModal);
  }

  // Import profile input
  const importInput = document.getElementById('profile-import-input');
  if (importInput) {
    importInput.addEventListener('change', handleProfileImport);
  }

  // Import profile button
  const importBtn = document.getElementById('import-profile-btn');
  if (importBtn) {
    importBtn.addEventListener('click', importProfileFromFile);
  }
}
