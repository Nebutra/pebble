import { FileText, RefreshCw, Save } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import {
  FileProjection,
  RuntimeFileContent,
} from '@/relay/relay-protocol'
import { runtimeFileContentKey } from '@/state/projection-state'
import { PebbleTheme } from '@/theme/pebble-theme'

export interface FileProjectionScreenProps {
  theme: PebbleTheme
  files: FileProjection[]
  fileContents: Record<string, RuntimeFileContent>
  lastError?: string
  onReadFile: (file: FileProjection) => void
  onWriteFile: (file: FileProjection, content: string) => void
}

export function FileProjectionScreen({
  theme,
  files,
  fileContents,
  lastError,
  onReadFile,
  onWriteFile,
}: FileProjectionScreenProps) {
  const styles = useMemo(() => createStyles(theme), [theme])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [draftByKey, setDraftByKey] = useState<Record<string, string>>({})

  const selectedFile = useMemo(() => {
    const file = selectedKey === null ? undefined : files.find((candidate) => fileKey(candidate) === selectedKey)
    return file ?? files.find((candidate) => candidate.entryKind === 'file') ?? files[0]
  }, [files, selectedKey])

  const selectedContent = selectedFile
    ? fileContents[fileKey(selectedFile)]
    : undefined
  const draft = selectedFile ? draftByKey[fileKey(selectedFile)] ?? selectedContent?.content ?? '' : ''
  const isWritable = selectedFile?.entryKind === 'file'
  const isDirty = selectedContent !== undefined && draft !== selectedContent.content

  useEffect(() => {
    if (selectedContent === undefined) {
      return
    }

    const key = runtimeFileContentKey(
      selectedContent.projectId,
      selectedContent.worktreeId,
      selectedContent.path,
    )
    setDraftByKey((current) => ({
      ...current,
      [key]: selectedContent.content,
    }))
  }, [selectedContent])

  if (files.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>No file projection</Text>
      </View>
    )
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.fileList}>
        {files.map((file) => {
          const key = fileKey(file)
          const isActive = selectedFile !== undefined && fileKey(selectedFile) === key

          return (
            <Pressable
              accessibilityRole="button"
              key={key}
              onPress={() => {
                setSelectedKey(key)
                if (file.entryKind === 'file') {
                  onReadFile(file)
                }
              }}
              style={({ pressed }) => [
                styles.fileRow,
                isActive ? styles.fileRowActive : null,
                pressed ? styles.buttonPressed : null,
              ]}
            >
              <FileText size={17} color={isActive ? theme.colors.primary : theme.colors.mutedForeground} />
              <View style={styles.fileRowText}>
                <Text style={styles.fileName}>{file.name}</Text>
                <Text style={styles.filePath}>{file.path}</Text>
              </View>
              <Text style={styles.fileKind}>{file.entryKind}</Text>
            </Pressable>
          )
        })}
      </View>

      {selectedFile !== undefined ? (
        <View style={styles.editorPanel}>
          <View style={styles.rowBetween}>
            <View style={styles.flexShrink}>
              <Text style={styles.editorTitle}>{selectedFile.name}</Text>
              <Text style={styles.filePath}>{selectedFile.path}</Text>
            </View>
            <Text style={styles.fileKind}>{selectedFile.isRemote ? 'remote' : 'local'}</Text>
          </View>

          <View style={styles.metaGrid}>
            <Text style={styles.metaLabel}>Workspace</Text>
            <Text style={styles.metaValue}>{selectedFile.workspaceId}</Text>
            <Text style={styles.metaLabel}>Size</Text>
            <Text style={styles.metaValue}>{selectedContent?.size ?? selectedFile.size ?? 0}</Text>
          </View>

          {isWritable ? (
            <>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onReadFile(selectedFile)}
                  style={({ pressed }) => [
                    styles.iconButton,
                    pressed ? styles.buttonPressed : null,
                  ]}
                >
                  <RefreshCw size={16} color={theme.colors.primaryForeground} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!isDirty}
                  onPress={() => onWriteFile(selectedFile, draft)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !isDirty ? styles.buttonDisabled : null,
                    pressed ? styles.buttonPressed : null,
                  ]}
                >
                  <Save size={16} color={theme.colors.primaryForeground} />
                  <Text style={styles.primaryButtonText}>Save</Text>
                </Pressable>
              </View>
              <TextInput
                value={draft}
                onChangeText={(text) =>
                  setDraftByKey((current) => ({
                    ...current,
                    [fileKey(selectedFile)]: text,
                  }))
                }
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                scrollEnabled
                style={styles.editorInput}
              />
            </>
          ) : (
            <Text style={styles.mutedText}>{selectedFile.entryKind}</Text>
          )}

          {lastError ? <Text style={styles.errorText}>{lastError}</Text> : null}
        </View>
      ) : null}
    </ScrollView>
  )
}

function fileKey(file: FileProjection): string {
  return runtimeFileContentKey(file.projectId, file.worktreeId, file.path)
}

function createStyles(theme: PebbleTheme) {
  return StyleSheet.create({
    scroll: {
      flex: 1,
    },
    scrollContent: {
      gap: theme.spacing.md,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xl,
    },
    fileList: {
      gap: theme.spacing.sm,
    },
    fileRow: {
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      flexDirection: 'row',
      gap: theme.spacing.sm,
      minHeight: 58,
      padding: theme.spacing.md,
    },
    fileRowActive: {
      borderColor: theme.colors.primary,
    },
    fileRowText: {
      flex: 1,
      minWidth: 0,
    },
    fileName: {
      color: theme.colors.cardForeground,
      fontSize: theme.typography.bodySize,
      fontWeight: '600',
    },
    filePath: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
    },
    fileKind: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
      textTransform: 'uppercase',
    },
    editorPanel: {
      backgroundColor: theme.colors.card,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      gap: theme.spacing.md,
      padding: theme.spacing.md,
    },
    rowBetween: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: theme.spacing.md,
      justifyContent: 'space-between',
    },
    flexShrink: {
      flex: 1,
      minWidth: 0,
    },
    editorTitle: {
      color: theme.colors.cardForeground,
      fontSize: theme.typography.titleSize,
      fontWeight: '600',
    },
    metaGrid: {
      gap: theme.spacing.xs,
    },
    metaLabel: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
      fontWeight: '600',
      textTransform: 'uppercase',
    },
    metaValue: {
      color: theme.colors.foreground,
      fontSize: theme.typography.captionSize,
    },
    actionRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    iconButton: {
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radii.sm,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.radii.sm,
      flexDirection: 'row',
      gap: theme.spacing.xs,
      justifyContent: 'center',
      minHeight: 40,
      paddingHorizontal: theme.spacing.lg,
    },
    primaryButtonText: {
      color: theme.colors.primaryForeground,
      fontSize: theme.typography.bodySize,
      fontWeight: '600',
    },
    buttonPressed: {
      opacity: 0.72,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    editorInput: {
      backgroundColor: theme.colors.background,
      borderColor: theme.colors.input,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      color: theme.colors.foreground,
      fontFamily: theme.typography.monoFamily,
      fontSize: 12,
      minHeight: 220,
      padding: theme.spacing.md,
      textAlignVertical: 'top',
    },
    mutedText: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
    },
    errorText: {
      color: theme.colors.destructive,
      fontSize: theme.typography.captionSize,
    },
    emptyState: {
      alignItems: 'center',
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderStyle: 'dashed',
      borderWidth: 1,
      justifyContent: 'center',
      marginTop: theme.spacing.md,
      minHeight: 220,
    },
    emptyStateText: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.bodySize,
    },
  })
}
