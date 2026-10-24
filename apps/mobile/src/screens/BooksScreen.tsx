import { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native"

import { invokeRpc, type MobileSession, type ProjectListItem } from "../api/client"

type Props = Readonly<{
  session: MobileSession
  onOpenBook: (project: ProjectListItem) => void
  onLogout: () => void
}>

export function BooksScreen(props: Props) {
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [projects, setProjects] = useState<ProjectListItem[]>([])

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const data = await invokeRpc<{ projects: ProjectListItem[] }>(props.session, "project.list", {})
      setProjects(data.projects)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [props.session])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>书库</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => void refresh()}><Text style={styles.link}>刷新</Text></Pressable>
          <Pressable onPress={props.onLogout}><Text style={styles.link}>退出</Text></Pressable>
        </View>
      </View>
      {busy ? <ActivityIndicator color="#3d7ea6" style={{ marginTop: 24 }} /> : null}
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={projects}
        keyExtractor={(item) => item.projectId}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        ListEmptyComponent={!busy ? <Text style={styles.empty}>服务器上还没有登记的书</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => props.onOpenBook(item)}>
            <Text style={styles.cardTitle}>{item.displayName}</Text>
            <Text style={styles.cardMeta} numberOfLines={1}>{item.workspaceRootRef}</Text>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0f1419" },
  header: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerActions: { flexDirection: "row", gap: 16 },
  title: { color: "#f2f5f8", fontSize: 22, fontWeight: "600" },
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
  cardTitle: { color: "#f2f5f8", fontSize: 17, fontWeight: "500" },
  cardMeta: { color: "#8b98a5", marginTop: 4, fontSize: 12 },
})
