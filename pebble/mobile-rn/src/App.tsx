import { StatusBar } from 'expo-status-bar'
import {
  Bot,
  CalendarClock,
  FileText,
  GitBranch,
  GitPullRequestArrow,
  Globe2,
  ListChecks,
  Plug,
  RefreshCw,
  Rocket,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Terminal,
  Trash2,
} from 'lucide-react-native'
import { useMemo, useState } from 'react'
import {
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native'

import { FileProjectionScreen } from '@/features/files/file-projection-screen'
import {
  AutomationProjectionScreen,
  ComputerActionProjectionScreen,
  EmulatorProjectionScreen,
  ExternalTaskProjectionScreen,
  OrchestrationProjectionScreen,
  ProviderProjectionScreen,
  ReleaseProjectionScreen,
  SettingsProjectionScreen,
} from '@/features/runtime-operations/runtime-operation-screens'
import {
  AgentProjection,
  BrowserDownloadProjection,
  BrowserProjection,
  ProjectionKind,
  SourceControlChange,
  SourceControlProjection,
  TerminalProjection,
} from '@/relay/relay-protocol'
import { selfTestRuntimeRelayCrypto } from '@/relay/runtime-relay-crypto-provider'
import { usePairingState } from '@/state/pairing-state'
import { useRuntimeSession } from '@/state/runtime-session'
import { getPebbleTheme, PebbleTheme } from '@/theme/pebble-theme'

type ActiveProjection = ProjectionKind
type CryptoDiagnosticState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'passed'; message: string }
  | { phase: 'failed'; message: string }

const projectionTabs: Array<{
  key: ActiveProjection
  label: string
  Icon: typeof Terminal
}> = [
  { key: 'terminal', label: 'Terminal', Icon: Terminal },
  { key: 'agents', label: 'Agents', Icon: Bot },
  { key: 'source-control', label: 'Source', Icon: GitBranch },
  { key: 'browser', label: 'Browser', Icon: Globe2 },
  { key: 'files', label: 'Files', Icon: FileText },
  { key: 'orchestration', label: 'Tasks', Icon: ListChecks },
  { key: 'automations', label: 'Auto', Icon: CalendarClock },
  { key: 'external-tasks', label: 'Work', Icon: GitPullRequestArrow },
  { key: 'releases', label: 'Release', Icon: Rocket },
  { key: 'providers', label: 'Providers', Icon: Server },
  { key: 'computer', label: 'Actions', Icon: Plug },
  { key: 'emulator', label: 'Emu', Icon: Smartphone },
  { key: 'settings', label: 'Settings', Icon: SlidersHorizontal },
]

const allProjectionKinds = projectionTabs.map((tab) => tab.key)

export default function App() {
  const colorScheme = useColorScheme()
  const theme = useMemo(() => getPebbleTheme(colorScheme), [colorScheme])
  const styles = useMemo(() => createStyles(theme), [theme])
  const pairing = usePairingState()
  const [endpoint, setEndpoint] = useState('ws://127.0.0.1:17777/v1/mobile-relay')
  const [pairingCode, setPairingCode] = useState('')
  const [activeProjection, setActiveProjection] = useState<ActiveProjection>('terminal')
  const [cryptoDiagnostic, setCryptoDiagnostic] = useState<CryptoDiagnosticState>({
    phase: 'idle',
  })

  const runtime = useRuntimeSession({
    pairingRecord: pairing.record,
    device: pairing.device,
    onPairingAccepted: (record) => {
      void pairing.completePairing(record)
    },
    onPairingRejected: pairing.rejectPairing,
    onConnected: () => {
      void pairing.markConnected()
    },
  })

  function startPairing() {
    const request = {
      endpoint: endpoint.trim(),
      pairingCode: pairingCode.trim(),
    }

    pairing.startPairing(request)
    runtime.beginPairing(request)
  }

  async function runCryptoDiagnostic() {
    setCryptoDiagnostic({ phase: 'running' })

    try {
      const result = await selfTestRuntimeRelayCrypto()
      setCryptoDiagnostic({
        phase: 'passed',
        message: `${result.provider} ok / ${result.keyId.slice(0, 10)} / ${result.encryptedBytes} bytes`,
      })
    } catch (error) {
      setCryptoDiagnostic({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Relay crypto self-test failed',
      })
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <View style={styles.shell}>
        <Header
          styles={styles}
          connectionPhase={runtime.connection.phase}
          workspaceName={pairing.record?.workspaceName}
        />

        <PairingPanel
          styles={styles}
          endpoint={endpoint}
          pairingCode={pairingCode}
          phase={pairing.phase}
          errorMessage={pairing.errorMessage ?? runtime.connection.errorMessage}
          onEndpointChange={setEndpoint}
          onPairingCodeChange={setPairingCode}
          onPair={startPairing}
          onReconnect={runtime.reconnect}
          onForget={() => {
            runtime.disconnect()
            void pairing.forgetPairing()
          }}
          cryptoDiagnostic={cryptoDiagnostic}
          onCryptoDiagnostic={() => {
            void runCryptoDiagnostic()
          }}
          isPaired={pairing.record !== null}
        />

        <View style={styles.projectionContainer}>
          <ProjectionSwitcher
            styles={styles}
            activeProjection={activeProjection}
            onChange={(nextProjection) => {
              setActiveProjection(nextProjection)
              runtime.subscribe(allProjectionKinds)
            }}
          />

          {activeProjection === 'terminal' ? (
            <TerminalProjectionScreen
              styles={styles}
              terminals={runtime.projection.terminals}
              onSendInput={runtime.sendTerminalInput}
            />
          ) : null}

          {activeProjection === 'agents' ? (
            <AgentProjectionScreen
              styles={styles}
              agents={runtime.projection.agents}
            />
          ) : null}

          {activeProjection === 'source-control' ? (
            <SourceControlProjectionScreen
              styles={styles}
              repositories={runtime.projection.sourceControl}
            />
          ) : null}

          {activeProjection === 'browser' ? (
            <BrowserProjectionScreen
              styles={styles}
              tabs={runtime.projection.browser}
              downloads={runtime.projection.browserDownloads}
              onCommand={runtime.sendBrowserCommand}
            />
          ) : null}

          {activeProjection === 'files' ? (
            <FileProjectionScreen
              theme={theme}
              files={runtime.projection.files}
              fileContents={runtime.projection.fileContents}
              lastError={runtime.projection.lastError}
              onReadFile={runtime.readFile}
              onWriteFile={runtime.writeFile}
            />
          ) : null}

          {activeProjection === 'orchestration' ? (
            <OrchestrationProjectionScreen
              theme={theme}
              tasks={runtime.projection.tasks}
              messages={runtime.projection.messages}
              dispatches={runtime.projection.dispatches}
            />
          ) : null}

          {activeProjection === 'automations' ? (
            <AutomationProjectionScreen
              theme={theme}
              automations={runtime.projection.automations}
            />
          ) : null}

          {activeProjection === 'external-tasks' ? (
            <ExternalTaskProjectionScreen
              theme={theme}
              externalTasks={runtime.projection.externalTasks}
            />
          ) : null}

          {activeProjection === 'releases' ? (
            <ReleaseProjectionScreen
              theme={theme}
              releases={runtime.projection.releases}
            />
          ) : null}

          {activeProjection === 'providers' ? (
            <ProviderProjectionScreen
              theme={theme}
              providers={runtime.projection.providers}
            />
          ) : null}

          {activeProjection === 'computer' ? (
            <ComputerActionProjectionScreen
              theme={theme}
              actions={runtime.projection.computerActions}
            />
          ) : null}

          {activeProjection === 'emulator' ? (
            <EmulatorProjectionScreen
              theme={theme}
              devices={runtime.projection.emulatorDevices}
              sessions={runtime.projection.emulatorSessions}
            />
          ) : null}

          {activeProjection === 'settings' ? (
            <SettingsProjectionScreen
              theme={theme}
              settings={runtime.projection.settings}
              keybindings={runtime.projection.keybindings}
            />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  )
}

function Header({
  styles,
  connectionPhase,
  workspaceName,
}: {
  styles: AppStyles
  connectionPhase: string
  workspaceName?: string
}) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.kicker}>Pebble Mobile</Text>
        <Text style={styles.title}>{workspaceName ?? 'Runtime Companion'}</Text>
      </View>
      <View style={styles.connectionPill}>
        <Plug size={15} color={styles.icon.color} />
        <Text style={styles.connectionPillText}>{connectionPhase}</Text>
      </View>
    </View>
  )
}

function PairingPanel({
  styles,
  endpoint,
  pairingCode,
  phase,
  errorMessage,
  isPaired,
  onEndpointChange,
  onPairingCodeChange,
  onPair,
  onReconnect,
  onForget,
  cryptoDiagnostic,
  onCryptoDiagnostic,
}: {
  styles: AppStyles
  endpoint: string
  pairingCode: string
  phase: string
  errorMessage?: string
  isPaired: boolean
  onEndpointChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onPair: () => void
  onReconnect: () => void
  onForget: () => void
  cryptoDiagnostic: CryptoDiagnosticState
  onCryptoDiagnostic: () => void
}) {
  const isCryptoDiagnosticRunning = cryptoDiagnostic.phase === 'running'
  const cryptoDiagnosticLabel = describeCryptoDiagnostic(cryptoDiagnostic)

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <View>
          <Text style={styles.kicker}>Pairing</Text>
          <Text style={styles.panelTitle}>{isPaired ? 'Desktop linked' : 'Connect runtime'}</Text>
        </View>
        <Text style={styles.phaseText}>{phase}</Text>
      </View>

      {!isPaired ? (
        <View style={styles.form}>
          <TextInput
            value={endpoint}
            onChangeText={onEndpointChange}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.input}
          />
          <View style={styles.formRow}>
            <TextInput
              value={pairingCode}
              onChangeText={onPairingCodeChange}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Pairing code"
              placeholderTextColor={styles.placeholder.color}
              style={[styles.input, styles.formRowInput]}
            />
            <Pressable
              accessibilityRole="button"
              disabled={phase === 'pairing'}
              onPress={onPair}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed ? styles.buttonPressed : null,
              ]}
            >
              <Text style={styles.primaryButtonText}>{phase === 'pairing' ? 'Pairing' : 'Pair'}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            onPress={onReconnect}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <RefreshCw size={16} color={styles.secondaryButtonText.color} />
            <Text style={styles.secondaryButtonText}>Reconnect</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onForget}
            style={({ pressed }) => [
              styles.dangerButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Trash2 size={16} color={styles.dangerButtonText.color} />
            <Text style={styles.dangerButtonText}>Forget</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.diagnosticRow}>
        <Pressable
          accessibilityRole="button"
          disabled={isCryptoDiagnosticRunning}
          onPress={onCryptoDiagnostic}
          style={({ pressed }) => [
            styles.secondaryButton,
            isCryptoDiagnosticRunning ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <ShieldCheck size={16} color={styles.secondaryButtonText.color} />
          <Text style={styles.secondaryButtonText}>
            {isCryptoDiagnosticRunning ? 'Testing' : 'Crypto test'}
          </Text>
        </Pressable>
        {cryptoDiagnosticLabel ? (
          <Text
            style={[
              styles.diagnosticText,
              cryptoDiagnostic.phase === 'failed' ? styles.errorText : styles.mutedText,
            ]}
          >
            {cryptoDiagnosticLabel}
          </Text>
        ) : null}
      </View>

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </View>
  )
}

function describeCryptoDiagnostic(state: CryptoDiagnosticState): string | null {
  if (state.phase === 'idle') {
    return null
  }
  if (state.phase === 'running') {
    return 'checking relay crypto'
  }

  return state.message
}

function ProjectionSwitcher({
  styles,
  activeProjection,
  onChange,
}: {
  styles: AppStyles
  activeProjection: ActiveProjection
  onChange: (projection: ActiveProjection) => void
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabBarScroll}
      contentContainerStyle={styles.tabBar}
    >
      {projectionTabs.map(({ key, label, Icon }) => {
        const isActive = key === activeProjection

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            key={key}
            onPress={() => onChange(key)}
            style={[styles.tabButton, isActive ? styles.tabButtonActive : null]}
          >
            <Icon size={16} color={isActive ? styles.tabButtonActiveText.color : styles.icon.color} />
            <Text style={[styles.tabButtonText, isActive ? styles.tabButtonActiveText : null]}>
              {label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

function AgentProjectionScreen({
  styles,
  agents,
}: {
  styles: AppStyles
  agents: AgentProjection[]
}) {
  if (agents.length === 0) {
    return <EmptyState styles={styles} title="No agent projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {agents.map((agent) => (
        <View key={agent.runId} style={styles.projectionPanel}>
          <View style={styles.rowBetween}>
            <View style={styles.flexShrink}>
              <Text style={styles.projectionTitle}>{agent.name}</Text>
              <Text style={styles.mutedText}>
                {agent.agentKind} / {agent.workspaceId}
              </Text>
            </View>
            <Text style={styles.phaseText}>{agent.status}</Text>
          </View>
          <View style={styles.agentMetaGrid}>
            <Text style={styles.agentMetaLabel}>Run</Text>
            <Text style={styles.agentMetaValue}>{agent.runId}</Text>
            <Text style={styles.agentMetaLabel}>Profile</Text>
            <Text style={styles.agentMetaValue}>{agent.profileId}</Text>
            <Text style={styles.agentMetaLabel}>Session</Text>
            <Text style={styles.agentMetaValue}>{agent.sessionId ?? '-'}</Text>
          </View>
          {agent.prompt ? <Text style={styles.mutedText}>{agent.prompt}</Text> : null}
        </View>
      ))}
    </ScrollView>
  )
}

function TerminalProjectionScreen({
  styles,
  terminals,
  onSendInput,
}: {
  styles: AppStyles
  terminals: TerminalProjection[]
  onSendInput: (sessionId: string, data: string) => void
}) {
  const [inputBySession, setInputBySession] = useState<Record<string, string>>({})

  if (terminals.length === 0) {
    return <EmptyState styles={styles} title="No terminal projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {terminals.map((terminal) => {
        const input = inputBySession[terminal.sessionId] ?? ''

        return (
          <View key={terminal.sessionId} style={styles.projectionPanel}>
            <View style={styles.rowBetween}>
              <View style={styles.flexShrink}>
                <Text style={styles.projectionTitle}>{terminal.title}</Text>
                <Text style={styles.mutedText}>{terminal.cwd ?? terminal.workspaceId}</Text>
              </View>
              <Text style={styles.phaseText}>{terminal.status}</Text>
            </View>
            <View style={styles.terminalOutput}>
              {terminal.output.length === 0 ? (
                <Text style={styles.terminalLine}>Waiting for output</Text>
              ) : (
                terminal.output.slice(-40).map((line) => (
                  <Text
                    key={line.id}
                    style={[
                      styles.terminalLine,
                      line.stream === 'stderr' ? styles.terminalErrorLine : null,
                    ]}
                  >
                    {line.text}
                  </Text>
                ))
              )}
            </View>
            <View style={styles.inputRow}>
              <TextInput
                value={input}
                onChangeText={(text) =>
                  setInputBySession((current) => ({
                    ...current,
                    [terminal.sessionId]: text,
                  }))
                }
                editable={terminal.inputEnabled}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Send input"
                placeholderTextColor={styles.placeholder.color}
                style={[styles.input, styles.inputRowText]}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!terminal.inputEnabled || input.length === 0}
                onPress={() => {
                  onSendInput(terminal.sessionId, input)
                  setInputBySession((current) => ({
                    ...current,
                    [terminal.sessionId]: '',
                  }))
                }}
                style={({ pressed }) => [
                  styles.iconButton,
                  pressed ? styles.buttonPressed : null,
                ]}
              >
                <Send size={17} color={styles.primaryButtonText.color} />
              </Pressable>
            </View>
          </View>
        )
      })}
    </ScrollView>
  )
}

function SourceControlProjectionScreen({
  styles,
  repositories,
}: {
  styles: AppStyles
  repositories: SourceControlProjection[]
}) {
  if (repositories.length === 0) {
    return <EmptyState styles={styles} title="No source-control projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {repositories.map((repository) => (
        <View key={`${repository.repositoryId}:${repository.workspaceId}`} style={styles.projectionPanel}>
          <View style={styles.rowBetween}>
            <View style={styles.flexShrink}>
              <Text style={styles.projectionTitle}>{repository.branch}</Text>
              <Text style={styles.mutedText}>
                {repository.provider} / {repository.reviewKind} / {repository.workspaceId}
              </Text>
            </View>
            <Text style={styles.phaseText}>{repository.syncStatus}</Text>
          </View>
          <Text style={styles.mutedText}>
            Ahead {repository.ahead} / Behind {repository.behind}
          </Text>
          <View style={styles.changeList}>
            {repository.changes.length === 0 ? (
              <Text style={styles.mutedText}>
                {repository.syncStatus === 'unknown' ? 'Status unavailable' : 'Working tree clean'}
              </Text>
            ) : (
              repository.changes.map((change) => (
                <ChangeRow key={`${change.status}:${change.path}`} styles={styles} change={change} />
              ))
            )}
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

function ChangeRow({ styles, change }: { styles: AppStyles; change: SourceControlChange }) {
  return (
    <View style={styles.changeRow}>
      <View style={[styles.changeStatusDot, styles.changeStatus[change.status]]} />
      <Text style={styles.changePath}>{change.path}</Text>
      <Text style={styles.changeStats}>
        {change.additions ?? 0}+ {change.deletions ?? 0}-
      </Text>
    </View>
  )
}

function BrowserProjectionScreen({
  styles,
  tabs,
  downloads,
  onCommand,
}: {
  styles: AppStyles
  tabs: BrowserProjection[]
  downloads: BrowserDownloadProjection[]
  onCommand: (
    tabId: string,
    command: 'reload' | 'goBack' | 'goForward' | 'stop' | 'screenshot'
  ) => void
}) {
  if (tabs.length === 0 && downloads.length === 0) {
    return <EmptyState styles={styles} title="No browser projection" />
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {tabs.map((tab) => (
        <View key={tab.tabId} style={styles.projectionPanel}>
          <View style={styles.rowBetween}>
            <View style={styles.flexShrink}>
              <Text style={styles.projectionTitle}>{tab.title}</Text>
              <Text style={styles.mutedText}>{tab.url}</Text>
            </View>
            <Text style={styles.phaseText}>{tab.status}</Text>
          </View>
          {tab.screenshot ? (
            <Image source={{ uri: tab.screenshot.uri }} style={styles.browserScreenshot} />
          ) : (
            <View style={styles.browserPlaceholder}>
              <Globe2 size={28} color={styles.icon.color} />
            </View>
          )}
          <View style={styles.actionRow}>
            <SmallCommandButton
              styles={styles}
              label="Back"
              disabled={!tab.canGoBack}
              onPress={() => onCommand(tab.tabId, 'goBack')}
            />
            <SmallCommandButton
              styles={styles}
              label="Forward"
              disabled={!tab.canGoForward}
              onPress={() => onCommand(tab.tabId, 'goForward')}
            />
            <SmallCommandButton
              styles={styles}
              label="Reload"
              onPress={() => onCommand(tab.tabId, 'reload')}
            />
            <SmallCommandButton
              styles={styles}
              label="Snapshot"
              onPress={() => onCommand(tab.tabId, 'screenshot')}
            />
          </View>
          {tab.errorMessage ? <Text style={styles.errorText}>{tab.errorMessage}</Text> : null}
        </View>
      ))}

      {downloads.map((download) => (
        <View key={download.downloadId} style={styles.projectionPanel}>
          <View style={styles.rowBetween}>
            <View style={styles.flexShrink}>
              <Text style={styles.projectionTitle}>{download.filename ?? download.downloadId}</Text>
              <Text style={styles.mutedText}>{download.url}</Text>
            </View>
            <Text style={styles.phaseText}>{download.status}</Text>
          </View>
          <Text style={styles.mutedText}>
            {downloadProgress(download)}
            {download.path ? ` / ${download.path}` : ''}
          </Text>
          {download.error ? <Text style={styles.errorText}>{download.error}</Text> : null}
        </View>
      ))}
    </ScrollView>
  )
}

function downloadProgress(download: BrowserDownloadProjection): string {
  const received = download.bytesReceived ?? 0
  const total = download.totalBytes ?? 0
  if (total > 0) return `${received}/${total} bytes`

  return `${received} bytes`
}

function SmallCommandButton({
  styles,
  label,
  disabled,
  onPress,
}: {
  styles: AppStyles
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallButton,
        disabled ? styles.buttonDisabled : null,
        pressed ? styles.buttonPressed : null,
      ]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  )
}

function EmptyState({ styles, title }: { styles: AppStyles; title: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateText}>{title}</Text>
    </View>
  )
}

type AppStyles = ReturnType<typeof createStyles>

function createStyles(theme: PebbleTheme) {
  return {
    ...StyleSheet.create({
      safeArea: {
        flex: 1,
        backgroundColor: theme.colors.background,
      },
      shell: {
        flex: 1,
        paddingHorizontal: theme.spacing.lg,
        paddingBottom: theme.spacing.lg,
        gap: theme.spacing.md,
      },
      header: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingTop: theme.spacing.md,
      },
      kicker: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: 24,
        fontWeight: '700',
      },
      connectionPill: {
        alignItems: 'center',
        borderColor: theme.colors.border,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.spacing.xs,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
      },
      connectionPillText: {
        color: theme.colors.foreground,
        fontSize: theme.typography.captionSize,
      },
      panel: {
        backgroundColor: theme.colors.card,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        gap: theme.spacing.md,
        padding: theme.spacing.md,
      },
      panelHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: theme.spacing.md,
      },
      panelTitle: {
        color: theme.colors.cardForeground,
        fontSize: theme.typography.titleSize,
        fontWeight: '600',
      },
      phaseText: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
      },
      form: {
        gap: theme.spacing.sm,
      },
      formRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.spacing.sm,
      },
      formRowInput: {
        flex: 1,
      },
      input: {
        backgroundColor: theme.colors.background,
        borderColor: theme.colors.input,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        color: theme.colors.foreground,
        fontSize: theme.typography.bodySize,
        minHeight: 40,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
      },
      primaryButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.primary,
        borderRadius: theme.radii.sm,
        justifyContent: 'center',
        minHeight: 40,
        paddingHorizontal: theme.spacing.lg,
      },
      primaryButtonText: {
        color: theme.colors.primaryForeground,
        fontSize: theme.typography.bodySize,
        fontWeight: '600',
      },
      secondaryButton: {
        alignItems: 'center',
        borderColor: theme.colors.border,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.spacing.xs,
        minHeight: 38,
        paddingHorizontal: theme.spacing.md,
      },
      secondaryButtonText: {
        color: theme.colors.foreground,
        fontSize: theme.typography.bodySize,
        fontWeight: '600',
      },
      dangerButton: {
        alignItems: 'center',
        borderColor: theme.colors.destructive,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.spacing.xs,
        minHeight: 38,
        paddingHorizontal: theme.spacing.md,
      },
      dangerButtonText: {
        color: theme.colors.destructive,
        fontSize: theme.typography.bodySize,
        fontWeight: '600',
      },
      buttonPressed: {
        opacity: 0.72,
      },
      buttonDisabled: {
        opacity: 0.45,
      },
      actionRow: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
      },
      diagnosticRow: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
      },
      diagnosticText: {
        flexShrink: 1,
      },
      errorText: {
        color: theme.colors.destructive,
        fontSize: theme.typography.captionSize,
      },
      projectionContainer: {
        flex: 1,
        minHeight: 0,
      },
      tabBar: {
        flexDirection: 'row',
        gap: theme.spacing.xs,
        padding: theme.spacing.xs,
      },
      tabBarScroll: {
        backgroundColor: theme.colors.muted,
        borderRadius: theme.radii.md,
        flexGrow: 0,
      },
      tabButton: {
        alignItems: 'center',
        borderRadius: theme.radii.sm,
        flexDirection: 'row',
        gap: theme.spacing.xs,
        justifyContent: 'center',
        minHeight: 40,
        minWidth: 92,
        paddingHorizontal: theme.spacing.sm,
      },
      tabButtonActive: {
        backgroundColor: theme.colors.card,
      },
      tabButtonText: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
        fontWeight: '600',
      },
      tabButtonActiveText: {
        color: theme.colors.foreground,
      },
      scroll: {
        flex: 1,
      },
      scrollContent: {
        gap: theme.spacing.md,
        paddingTop: theme.spacing.md,
        paddingBottom: theme.spacing.xl,
      },
      projectionPanel: {
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
      projectionTitle: {
        color: theme.colors.cardForeground,
        fontSize: theme.typography.titleSize,
        fontWeight: '600',
      },
      mutedText: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
      },
      terminalOutput: {
        backgroundColor: theme.mode === 'dark' ? '#050505' : '#111',
        borderRadius: theme.radii.sm,
        minHeight: 160,
        padding: theme.spacing.md,
      },
      terminalLine: {
        color: '#f2f2f2',
        fontFamily: theme.typography.monoFamily,
        fontSize: 12,
      },
      terminalErrorLine: {
        color: '#ffb4b4',
      },
      inputRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.spacing.sm,
      },
      inputRowText: {
        flex: 1,
      },
      iconButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.primary,
        borderRadius: theme.radii.sm,
        height: 40,
        justifyContent: 'center',
        width: 40,
      },
      changeList: {
        gap: theme.spacing.sm,
      },
      changeRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.spacing.sm,
        minHeight: 26,
      },
      changeStatusDot: {
        borderRadius: theme.radii.pill,
        height: 8,
        width: 8,
      },
      changePath: {
        color: theme.colors.foreground,
        flex: 1,
        fontSize: theme.typography.bodySize,
      },
      changeStats: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
      },
      browserScreenshot: {
        aspectRatio: 16 / 10,
        backgroundColor: theme.colors.muted,
        borderRadius: theme.radii.sm,
        width: '100%',
      },
      browserPlaceholder: {
        alignItems: 'center',
        aspectRatio: 16 / 10,
        backgroundColor: theme.colors.muted,
        borderRadius: theme.radii.sm,
        justifyContent: 'center',
        width: '100%',
      },
      agentMetaGrid: {
        display: 'flex',
        gap: theme.spacing.xs,
      },
      agentMetaLabel: {
        color: theme.colors.mutedForeground,
        fontSize: theme.typography.captionSize,
        fontWeight: '600',
        textTransform: 'uppercase',
      },
      agentMetaValue: {
        color: theme.colors.foreground,
        fontSize: theme.typography.captionSize,
      },
      smallButton: {
        borderColor: theme.colors.border,
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        minHeight: 34,
        paddingHorizontal: theme.spacing.md,
        justifyContent: 'center',
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
    }),
    icon: {
      color: theme.colors.mutedForeground,
    },
    placeholder: {
      color: theme.colors.mutedForeground,
    },
    changeStatus: {
      added: { backgroundColor: theme.colors.gitAdded },
      modified: { backgroundColor: theme.colors.gitModified },
      deleted: { backgroundColor: theme.colors.gitDeleted },
      renamed: { backgroundColor: theme.colors.gitRenamed },
      untracked: { backgroundColor: theme.colors.gitAdded },
      ignored: { backgroundColor: theme.colors.gitIgnored },
    },
  }
}
