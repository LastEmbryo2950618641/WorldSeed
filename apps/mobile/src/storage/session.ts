import AsyncStorage from "@react-native-async-storage/async-storage"

import type { MobileSession } from "../api/client"

const KEY = "worldseed.mobile.session.v1"

export async function loadSession(): Promise<MobileSession | undefined> {
  const raw = await AsyncStorage.getItem(KEY)
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<MobileSession>
    if (typeof parsed.apiBaseUrl !== "string" || typeof parsed.apiToken !== "string") return undefined
    if (parsed.apiBaseUrl.trim().length === 0 || parsed.apiToken.trim().length === 0) return undefined
    return { apiBaseUrl: parsed.apiBaseUrl.trim(), apiToken: parsed.apiToken.trim() }
  } catch {
    return undefined
  }
}

export async function saveSession(session: MobileSession): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(session))
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(KEY)
}
