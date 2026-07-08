import {
  CalendarClock,
  GitPullRequestArrow,
  ListChecks,
  Plug,
  Rocket,
  Server,
  SlidersHorizontal,
  Smartphone,
} from 'lucide-react-native'
import { useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  AutomationProjection,
  ComputerActionProjection,
  DispatchProjection,
  EmulatorDeviceProjection,
  EmulatorSessionProjection,
  ExternalTaskProjection,
  KeybindingProjection,
  MessageProjection,
  ProviderProjection,
  ReleaseProjection,
  SettingProjection,
  TaskProjection,
} from '@/relay/relay-protocol'
import { PebbleTheme } from '@/theme/pebble-theme'

export function OrchestrationProjectionScreen({
  theme,
  tasks,
  messages,
  dispatches,
}: {
  theme: PebbleTheme
  tasks: TaskProjection[]
  messages: MessageProjection[]
  dispatches: DispatchProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (tasks.length === 0 && messages.length === 0 && dispatches.length === 0) {
    return <EmptyState styles={styles} title="No orchestration projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {tasks.map((task) => (
        <View key={task.taskId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <ListChecks size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{task.title}</Text>
                <Text style={styles.mutedText}>{task.taskId}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{task.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Assignee" value={task.assignee ?? '-'} />
            <MetaValue styles={styles} label="Dispatches" value={countDispatches(dispatches, task.taskId)} />
            <MetaValue styles={styles} label="Messages" value={messages.length.toString()} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

export function AutomationProjectionScreen({
  theme,
  automations,
}: {
  theme: PebbleTheme
  automations: AutomationProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (automations.length === 0) {
    return <EmptyState styles={styles} title="No automation projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {automations.map((automation) => (
        <View key={automation.automationId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <CalendarClock size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{automation.name}</Text>
                <Text style={styles.mutedText}>{automation.description ?? automation.automationId}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{automation.enabled ? 'enabled' : 'disabled'}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Schedule" value={automation.scheduleKind} />
            <MetaValue styles={styles} label="Action" value={automation.actionKind} />
            <MetaValue styles={styles} label="Next" value={automation.nextRunAt ?? '-'} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

export function ExternalTaskProjectionScreen({
  theme,
  externalTasks,
}: {
  theme: PebbleTheme
  externalTasks: ExternalTaskProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (externalTasks.length === 0) {
    return <EmptyState styles={styles} title="No external task projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {externalTasks.map((item) => (
        <View key={item.itemId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <GitPullRequestArrow size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.mutedText}>
                  {item.provider} / {item.itemKind} / {item.externalId}
                </Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{item.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Review" value={item.reviewKind ?? '-'} />
            <MetaValue styles={styles} label="Assignee" value={item.assignee ?? '-'} />
            <MetaValue styles={styles} label="Task" value={item.taskId ?? '-'} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

export function ReleaseProjectionScreen({
  theme,
  releases,
}: {
  theme: PebbleTheme
  releases: ReleaseProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (releases.length === 0) {
    return <EmptyState styles={styles} title="No release projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {releases.map((release) => (
        <View key={release.releaseId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <Rocket size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{release.version}</Text>
                <Text style={styles.mutedText}>{release.channel}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{release.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue
              styles={styles}
              label="Artifacts"
              value={`${release.artifactCount}/${release.requiredCount}`}
            />
            <MetaValue
              styles={styles}
              label="Checks"
              value={`${release.passedCheckCount}/${release.checkCount}`}
            />
            <MetaValue styles={styles} label="Failed" value={release.failedCheckCount.toString()} />
            <MetaValue styles={styles} label="Ready" value={release.ready ? 'yes' : 'no'} />
            <MetaValue
              styles={styles}
              label="Manifest"
              value={release.updateManifestUri ? 'set' : '-'}
            />
          </View>
          {release.updateManifestUri ? (
            <Text style={styles.mutedText}>{release.updateManifestUri}</Text>
          ) : null}
          {release.blockedReason ? <Text style={styles.errorText}>{release.blockedReason}</Text> : null}
        </View>
      ))}
    </ScrollView>
  )
}

export function ProviderProjectionScreen({
  theme,
  providers,
}: {
  theme: PebbleTheme
  providers: ProviderProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (providers.length === 0) {
    return <EmptyState styles={styles} title="No provider projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {providers.map((provider) => (
        <View key={provider.providerId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <Server size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{provider.name}</Text>
                <Text style={styles.mutedText}>{provider.subsystem}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{provider.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Capabilities" value={provider.capabilities.length.toString()} />
            <MetaValue styles={styles} label="Last seen" value={provider.lastSeenAt} />
            <MetaValue styles={styles} label="ID" value={provider.providerId} />
          </View>
          {provider.message ? <Text style={styles.mutedText}>{provider.message}</Text> : null}
        </View>
      ))}
    </ScrollView>
  )
}

export function ComputerActionProjectionScreen({
  theme,
  actions,
}: {
  theme: PebbleTheme
  actions: ComputerActionProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (actions.length === 0) {
    return <EmptyState styles={styles} title="No computer action projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {actions.map((action) => (
        <View key={action.actionId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <Plug size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{action.actionKind}</Text>
                <Text style={styles.mutedText}>{action.target ?? action.actionId}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{action.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Payload" value={countRecordKeys(action.payload)} />
            <MetaValue styles={styles} label="Result" value={countRecordKeys(action.result)} />
            <MetaValue styles={styles} label="Updated" value={action.updatedAt} />
          </View>
          {action.error ? <Text style={styles.errorText}>{action.error}</Text> : null}
        </View>
      ))}
    </ScrollView>
  )
}

export function EmulatorProjectionScreen({
  theme,
  devices,
  sessions,
}: {
  theme: PebbleTheme
  devices: EmulatorDeviceProjection[]
  sessions: EmulatorSessionProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (devices.length === 0 && sessions.length === 0) {
    return <EmptyState styles={styles} title="No emulator projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {devices.map((device) => (
        <View key={device.deviceId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <Smartphone size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{device.name}</Text>
                <Text style={styles.mutedText}>
                  {device.platform} / {device.runtime ?? '-'}
                </Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{device.status}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Sessions" value={countDeviceSessions(sessions, device.deviceId)} />
            <MetaValue styles={styles} label="Updated" value={device.updatedAt} />
            <MetaValue styles={styles} label="ID" value={device.deviceId} />
          </View>
          {device.error ? <Text style={styles.errorText}>{device.error}</Text> : null}
        </View>
      ))}

      {sessions.map((session) => (
        <View key={session.sessionId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <Smartphone size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{session.sessionId}</Text>
                <Text style={styles.mutedText}>
                  {session.deviceId} / {session.workspaceId}
                </Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{session.active ? 'active' : 'detached'}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Device" value={session.deviceId} />
            <MetaValue styles={styles} label="Workspace" value={session.workspaceId} />
            <MetaValue styles={styles} label="Updated" value={session.updatedAt} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

export function SettingsProjectionScreen({
  theme,
  settings,
  keybindings,
}: {
  theme: PebbleTheme
  settings: SettingProjection[]
  keybindings: KeybindingProjection[]
}) {
  const styles = useMemo(() => createStyles(theme), [theme])

  if (settings.length === 0 && keybindings.length === 0) {
    return <EmptyState styles={styles} title="No settings projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {settings.map((setting) => (
        <View key={setting.settingId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <SlidersHorizontal size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{setting.key}</Text>
                <Text style={styles.mutedText}>{setting.scope}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>setting</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Project" value={setting.projectId ?? '-'} />
            <MetaValue styles={styles} label="Workspace" value={setting.workspaceId ?? '-'} />
            <MetaValue styles={styles} label="Updated" value={setting.updatedAt} />
          </View>
        </View>
      ))}

      {keybindings.map((keybinding) => (
        <View key={keybinding.keybindingId} style={styles.panel}>
          <View style={styles.rowBetween}>
            <View style={styles.titleRow}>
              <SlidersHorizontal size={17} color={theme.colors.mutedForeground} />
              <View style={styles.flexShrink}>
                <Text style={styles.title}>{keybinding.command}</Text>
                <Text style={styles.mutedText}>{keybinding.accelerator}</Text>
              </View>
            </View>
            <Text style={styles.phaseText}>{keybinding.enabled ? 'enabled' : 'disabled'}</Text>
          </View>
          <View style={styles.metaGrid}>
            <MetaValue styles={styles} label="Platform" value={keybinding.platform ?? 'all'} />
            <MetaValue styles={styles} label="Context" value={keybinding.context ?? '-'} />
            <MetaValue styles={styles} label="Updated" value={keybinding.updatedAt} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

function MetaValue({
  styles,
  label,
  value,
}: {
  styles: OperationStyles
  label: string
  value: string
}) {
  return (
    <>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </>
  )
}

function countDispatches(dispatches: DispatchProjection[], taskId: string): string {
  return dispatches.filter((dispatch) => dispatch.taskId === taskId).length.toString()
}

function countDeviceSessions(sessions: EmulatorSessionProjection[], deviceId: string): string {
  return sessions.filter((session) => session.deviceId === deviceId).length.toString()
}

function countRecordKeys(value: Record<string, unknown> | undefined): string {
  return value ? Object.keys(value).length.toString() : '0'
}

function EmptyState({
  styles,
  title,
}: {
  styles: OperationStyles
  title: string
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateText}>{title}</Text>
    </View>
  )
}

type OperationStyles = ReturnType<typeof createStyles>

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
    panel: {
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
    titleRow: {
      alignItems: 'flex-start',
      flex: 1,
      flexDirection: 'row',
      gap: theme.spacing.sm,
      minWidth: 0,
    },
    flexShrink: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: theme.colors.cardForeground,
      fontSize: theme.typography.titleSize,
      fontWeight: '600',
    },
    mutedText: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
    },
    phaseText: {
      color: theme.colors.mutedForeground,
      fontSize: theme.typography.captionSize,
      textTransform: 'uppercase',
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
