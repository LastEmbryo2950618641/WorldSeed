import { useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"

import { checkHealth, type MobileSession } from "../api/client"

type Props = Readonly<{
  initial?: MobileSession | undefined
  onConnected: (session: MobileSession) => void
}>

export function LoginScreen(props: Props) {
  const [apiBaseUrl, setApiBaseUrl] = useState(props.initial?.apiBaseUrl ?? "https://")
  const [apiToken, setApiToken] = useState(props.initial?.apiToken ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const connect = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const session: MobileSession = {
        apiBaseUrl: apiBaseUrl.trim().replace(/\/+$/u, ""),
        apiToken: apiToken.trim(),
      }
      if (session.apiBaseUrl.length < 8 || session.apiToken.length === 0) {
        throw new Error("填写服务地址与 API Token（不是 SSH 密码）")
      }
      const health = await checkHealth(session.apiBaseUrl)
      if (!health.ok) throw new Error("健康检查失败：无法访问 /health")
      props.onConnected(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>WorldSeed</Text>
      <Text style={styles.hint}>连接自建后端（Bearer Token，勿填系统账号密码）</Text>
      <Text style={styles.label}>API Base URL</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="https://your-host"
        style={styles.input}
        value={apiBaseUrl}
        onChangeText={setApiBaseUrl}
      />
      <Text style={styles.label}>API Token</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="WORLDSEED_API_TOKEN"
        secureTextEntry
        style={styles.input}
        value={apiToken}
        onChangeText={setApiToken}
      />
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable disabled={busy} style={styles.button} onPress={() => void connect()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>连接</Text>}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#0f1419", gap: 10 },
  title: { color: "#f2f5f8", fontSize: 28, fontWeight: "600", marginBottom: 4 },
  hint: { color: "#8b98a5", marginBottom: 16 },
  label: { color: "#c5d0da", fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: "#2a3540",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#f2f5f8",
    backgroundColor: "#171e26",
  },
  button: {
    marginTop: 12,
    backgroundColor: "#3d7ea6",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#e57373" },
})
