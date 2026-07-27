import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, X } from 'lucide-react-native'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  flattenDirectoryCache,
  getDirectoryCacheState,
  type DirectoryCache,
  type FileExplorerRow,
  type MobileDirEntry
} from './file-tree'
import type { RpcSuccess } from '../transport/types'
import { colors } from '../theme/mobile-theme'
import {
  beginDirectoryLoad,
  createDirectoryLoadRevisions,
  isCurrentDirectoryLoad,
  resetDirectoryLoadRevisions,
  type DirectoryLoadRevisions
} from './directory-load-revisions'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { MobileFileExplorerRow } from './mobile-file-explorer-row'
import { navigateToMobileFilePreview } from './mobile-file-preview-navigation'

export function MobileFileExplorerPanel(props: {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  onRequestClose?: () => void
}) {
  const { hostId, worktreeId, name, embedded, onRequestClose } = props
  const router = useRouter()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const scopeRef = useRef('')
  const scope = `${hostId}:${worktreeId}`
  scopeRef.current = scope
  const directoryLoadRevisionsRef = useRef<DirectoryLoadRevisions>(createDirectoryLoadRevisions())
  const pendingDirectoryRetriesRef = useRef<Set<string>>(new Set())
  const directoryCacheRef = useRef<DirectoryCache>({})
  const [directoryCache, setDirectoryCache] = useState<DirectoryCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      const loadScope = scopeRef.current
      const loadToken = beginDirectoryLoad(
        directoryLoadRevisionsRef.current,
        loadScope,
        relativePath
      )
      const rootLoad = relativePath === ''

      if (!client || connState !== 'connected') {
        const message =
          connState === 'connected' ? 'Connecting to desktop...' : 'Waiting for desktop...'
        if (rootLoad) {
          const hasLoadedRoot =
            (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
          setLoading(false)
          // Why: transient reconnects should not blank an already browsable tree.
          setError(hasLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
        return
      }

      if (rootLoad) {
        setLoading(true)
        setError(null)
      }
      setDirectoryCache((prev) => ({
        ...prev,
        [relativePath]: {
          entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
          loading: true
        }
      }))

      try {
        const response = await client.sendRequest('files.readDir', {
          worktree: `id:${worktreeId}`,
          relativePath
        })
        if (!response.ok) {
          throw new Error(response.error?.message || 'Unable to load files')
        }
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        const entries = (response as RpcSuccess).result as MobileDirEntry[]
        setDirectoryCache((prev) => ({
          ...prev,
          [relativePath]: { entries }
        }))
      } catch (err) {
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        const message = err instanceof Error ? err.message : 'Unable to load files'
        if (rootLoad) {
          setError(message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
      } finally {
        if (
          rootLoad &&
          isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          setLoading(false)
        }
      }
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    scopeRef.current = scope
    resetDirectoryLoadRevisions(directoryLoadRevisionsRef.current)
    pendingDirectoryRetriesRef.current.clear()
    directoryCacheRef.current = {}
    setDirectoryCache({})
    setExpanded(new Set())
    setLoading(true)
    setError(null)
  }, [scope])

  useEffect(() => {
    directoryCacheRef.current = directoryCache
  }, [directoryCache])

  useEffect(() => {
    void loadDirectory('')
  }, [hostId, loadDirectory])

  useEffect(() => {
    if (connState !== 'connected' || pendingDirectoryRetriesRef.current.size === 0) {
      return
    }
    const pending = [...pendingDirectoryRetriesRef.current]
    pendingDirectoryRetriesRef.current.clear()
    for (const relativePath of pending) {
      void loadDirectory(relativePath)
    }
  }, [connState, loadDirectory])

  const rows = useMemo(
    () => flattenDirectoryCache(directoryCache, expanded),
    [directoryCache, expanded]
  )

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
        }
        return next
      })
      const state = getDirectoryCacheState(directoryCache, relativePath)
      if (!expanded.has(relativePath) && !state?.loading && (!state?.entries || state.error)) {
        void loadDirectory(relativePath)
      }
    },
    [directoryCache, expanded, loadDirectory]
  )

  const retryDirectory = useCallback(
    (relativePath: string) => {
      if (connState !== 'connected' && hostId) {
        pendingDirectoryRetriesRef.current.add(relativePath)
        void forceReconnect(hostId)
        return
      }
      void loadDirectory(relativePath)
    },
    [connState, forceReconnect, hostId, loadDirectory]
  )

  const previewFile = useCallback(
    (relativePath: string, displayName: string) => {
      navigateToMobileFilePreview(
        router,
        {
          hostId,
          worktreeId,
          relativePath,
          name: displayName,
          worktreeName: name
        },
        { embedded, onRequestClose }
      )
    },
    [embedded, hostId, name, onRequestClose, router, worktreeId]
  )

  const renderItem: ListRenderItem<FileExplorerRow> = ({ item }) => {
    return (
      <MobileFileExplorerRow
        item={item}
        expanded={expanded}
        onPreviewFile={previewFile}
        onRetryDirectory={retryDirectory}
        onToggleDirectory={toggleDirectory}
      />
    )
  }

  const headerBar = (
    <View style={styles.topBar}>
      {embedded ? (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => onRequestClose?.()}
          hitSlop={8}
          accessibilityLabel="Close files"
        >
          <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back to session"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          Files
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {worktreeLabel}
        </Text>
      </View>
    </View>
  )

  const body = loading ? (
    <View style={styles.state}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : error ? (
    <View style={styles.state}>
      <Text style={styles.errorText}>{error}</Text>
      {/* Why: while disconnected, re-sending the request is useless — revive
          the parked transport instead; loadDirectory re-runs via its effect
          once the new client connects. */}
      <Pressable
        style={styles.retryButton}
        onPress={() =>
          connState !== 'connected' && hostId ? void forceReconnect(hostId) : void loadDirectory('')
        }
      >
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  ) : rows.length === 0 ? (
    <View style={styles.state}>
      <Text style={styles.emptyText}>No files found</Text>
    </View>
  ) : (
    <FlatList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
    />
  )

  // Embedded: the dock column owns safe-area/layout, so render a plain View and
  // a non-inset header. Full-screen: keep the SafeAreaView top inset + chrome.
  return (
    <View style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{headerBar}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {headerBar}
        </SafeAreaView>
      )}
      {body}
    </View>
  )
}
