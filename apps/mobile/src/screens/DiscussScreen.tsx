import { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"

import { invokeRpc, type MobileSession, type ProjectListItem } from "../api/client"

type ChatLine = Readonly<{
  id: string
  role: "user" | "assistant" | "system"
  text: string
}>

type Props = Readonly<{
  session: MobileSession
  project: ProjectListItem
  onBack: () => void
  onOpenChapters: () => void
}>

const DEFAULT_PRESENTATION = {
  minimumWordCount: 2000,
  maximumWordCount: 3000,
} as const

export function DiscussScreen(props: Props) {
  const [lines, setLines] = useState<ChatLine[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [sessionReady, setSessionReady] = useState(false)

  const ensureConversation = useCallback(async () => {
    setError(undefined)
    try {
      await invokeRpc(props.session, "project.open", {
        workspaceRootRef: props.project.workspaceRootRef,
      })
      const listed = await invokeRpc<{ sessions?: readonly { sessionId?: string }[] }>(
        props.session,
        "synopsis.conversation.list",
        {
          projectId: props.project.projectId,
          workspaceRootRef: props.project.workspaceRootRef,
        },
      )
      if ((listed.sessions?.length ?? 0) === 0) {
        await invokeRpc(props.session, "synopsis.conversation.start", {
          projectId: props.project.projectId,
          workspaceRootRef: props.project.workspaceRootRef,
          title: "mobile",
        })
      }
      setSessionReady(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [props.project, props.session])

  useEffect(() => {
    void ensureConversation()
  }, [ensureConversation])

  const send = async () => {
    const message = draft.trim()
    if (message.length === 0 || busy) return
    setBusy(true)
    setError(undefined)
    setDraft("")
    setLines((current) => [
      ...current,
      { id: `u-${String(Date.now())}`, role: "user", text: message },
    ])
    try {
      const sent = await invokeRpc<{
        assistantMessage?: string
        choices?: readonly { label: string }[]
        session?: { sessionId?: string }
      }>(props.session, "synopsis.conversation.send", {
        projectId: props.project.projectId,
        workspaceRootRef: props.project.workspaceRootRef,
        message,
        presentation: DEFAULT_PRESENTATION,
      })
      const assistant = sent.assistantMessage?.trim()
        ?? (sent.choices !== undefined && sent.choices.length > 0
          ? sent.choices.map((c) => `· ${c.label}`).join("\n")
          : "（本轮无文本回复，可点章节查看落盘）")
      setLines((current) => [
        ...current,
        { id: `a-${String(Date.now())}`, role: "assistant", text: assistant },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack}><Text style={styles.link}>书库</Text></Pressable>
        <Text style={styles.title} numberOfLines={1}>{props.project.displayName}</Text>
        <Pressable onPress={props.onOpenChapters}><Text style={styles.link}>章节</Text></Pressable>
      </View>
      {!sessionReady && error === undefined ? (
        <ActivityIndicator color="#3d7ea6" style={{ marginTop: 24 }} />
      ) : null}
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        data={lines}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === "user" ? styles.user : styles.assistant]}>
            <Text style={styles.bubbleText}>{item.text}</Text>
          </View>
        )}
      />
      <View style={styles.composer}>
        <TextInput
          editable={!busy && sessionReady}
          multiline
          placeholder="说一句卖点或继续讨论…"
          placeholderTextColor="#6a7682"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
        />
        <Pressable
          disabled={busy || !sessionReady}
          style={[styles.send, (busy || !sessionReady) ? styles.sendDisabled : null]}
          onPress={() => void send()}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>发送</Text>}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0f1419" },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { flex: 1, textAlign: "center", color: "#f2f5f8", fontWeight: "600" },
  link: { color: "#6eb6d9" },
  error: { color: "#e57373", paddingHorizontal: 16 },
  bubble: { borderRadius: 12, padding: 12, maxWidth: "92%" },
  user: { alignSelf: "flex-end", backgroundColor: "#2a4a5c" },
  assistant: { alignSelf: "flex-start", backgroundColor: "#171e26", borderWidth: 1, borderColor: "#2a3540" },
  bubbleText: { color: "#f2f5f8", lineHeight: 20 },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#2a3540",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#2a3540",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#f2f5f8",
    backgroundColor: "#171e26",
  },
  send: {
    backgroundColor: "#3d7ea6",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minWidth: 72,
    alignItems: "center",
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: "#fff", fontWeight: "600" },
})
