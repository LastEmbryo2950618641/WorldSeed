import { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"

import { invokeRpc, type MobileSession, type ProjectListItem } from "../api/client"

type ChapterRow = Readonly<{
  chapterId?: string
  chapterSequence?: number
  title?: string
  publishPath?: string
}>

type Props = Readonly<{
  session: MobileSession
  project: ProjectListItem
  onBack: () => void
}>

export function ChaptersScreen(props: Props) {
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [chapters, setChapters] = useState<ChapterRow[]>([])
  const [body, setBody] = useState<string | undefined>()
  const [readingTitle, setReadingTitle] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const data = await invokeRpc<{ chapters?: ChapterRow[] } | ChapterRow[]>(
        props.session,
        "chapter.list",
        {
          projectId: props.project.projectId,
          workspaceRootRef: props.project.workspaceRootRef,
        },
      )
      const rows = Array.isArray(data) ? data : (data.chapters ?? [])
      setChapters(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [props.project, props.session])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openChapter = async (row: ChapterRow) => {
    if (row.chapterId === undefined || row.chapterId.length === 0) {
      setError("该条目缺少 chapterId，无法读取")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const data = await invokeRpc<{ markdown?: string; body?: string; title?: string }>(
        props.session,
        "chapter.read",
        {
          projectId: props.project.projectId,
          workspaceRootRef: props.project.workspaceRootRef,
          chapterId: row.chapterId,
        },
      )
      setReadingTitle(data.title ?? row.title ?? `第${String(row.chapterSequence ?? "?")}章`)
      setBody(data.markdown ?? data.body ?? "（空）")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (body !== undefined) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={() => setBody(undefined)}><Text style={styles.link}>列表</Text></Pressable>
          <Text style={styles.title} numberOfLines={1}>{readingTitle}</Text>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Text style={styles.body}>{body}</Text>
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack}><Text style={styles.link}>讨论</Text></Pressable>
        <Text style={styles.title}>章节</Text>
        <Pressable onPress={() => void refresh()}><Text style={styles.link}>刷新</Text></Pressable>
      </View>
      {busy ? <ActivityIndicator color="#3d7ea6" style={{ marginTop: 24 }} /> : null}
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={chapters}
        keyExtractor={(item, index) => item.chapterId ?? `ch-${String(index)}`}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListEmptyComponent={!busy ? <Text style={styles.empty}>暂无章节</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => void openChapter(item)}>
            <Text style={styles.cardTitle}>
              {item.title ?? `第 ${String(item.chapterSequence ?? "?")} 章`}
            </Text>
            {item.publishPath !== undefined ? (
              <Text style={styles.cardMeta} numberOfLines={1}>{item.publishPath}</Text>
            ) : null}
          </Pressable>
        )}
      />
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
  },
  title: { color: "#f2f5f8", fontWeight: "600", fontSize: 18 },
  link: { color: "#6eb6d9" },
  error: { color: "#e57373", paddingHorizontal: 16 },
  empty: { color: "#8b98a5", textAlign: "center", marginTop: 40 },
  card: {
    backgroundColor: "#171e26",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#2a3540",
  },
  cardTitle: { color: "#f2f5f8", fontSize: 16 },
  cardMeta: { color: "#8b98a5", marginTop: 4, fontSize: 12 },
  body: { color: "#e8eef4", lineHeight: 24, fontSize: 16 },
})
