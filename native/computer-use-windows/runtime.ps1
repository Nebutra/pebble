param(
    [Parameter(Mandatory = $true)]
    [string]$OperationPath
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PebbleDesktopWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
}
"@

$MaxNodes = 1200
$MaxDepth = 64
$TextLimit = 500
$MaxScreenshotPngBytes = 900000
$MaxScreenshotEdge = 1280
$MinScreenshotScale = 0.25
$ScreenshotScaleStep = 0.85
$BlockedAppFragments = @(
    "1password",
    "bitwarden",
    "dashlane",
    "lastpass",
    "nordpass",
    "proton pass"
)

$WindowsMessages = @{
    Char = 0x0102
    KeyDown = 0x0100
    KeyUp = 0x0101
    MouseMove = 0x0200
    LeftDown = 0x0201
    LeftUp = 0x0202
    RightDown = 0x0204
    RightUp = 0x0205
    MiddleDown = 0x0207
    MiddleUp = 0x0208
    Wheel = 0x020A
}

$MouseEvents = @{
    LeftDown = 0x0002
    LeftUp = 0x0004
    RightDown = 0x0008
    RightUp = 0x0010
    MiddleDown = 0x0020
    MiddleUp = 0x0040
    Wheel = 0x0800
}

function Write-PebbleJson($Payload) {
    $Payload | ConvertTo-Json -Depth 100 -Compress
}

function New-PebbleFrame([double]$X, [double]$Y, [double]$Width, [double]$Height) {
    if ($Width -le 0 -or $Height -le 0) { return $null }
    [pscustomobject]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function Read-PebbleOperation([string]$Path) {
    Get-Content -Raw -Encoding UTF8 -Path $Path | ConvertFrom-Json
}

function ConvertTo-PebbleLParam([int]$X, [int]$Y) {
    [IntPtr]((($Y -band 0xffff) -shl 16) -bor ($X -band 0xffff))
}

function ConvertTo-PebbleWheelParam([int]$Delta) {
    [IntPtr](($Delta -band 0xffff) -shl 16)
}

function Get-PebbleWindowProcesses {
    @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id)
}

function Find-PebbleProcess([string]$Query) {
    $needle = ""
    if ($null -ne $Query) { $needle = $Query.Trim() }
    if ([string]::IsNullOrWhiteSpace($needle)) { throw 'appNotFound("")' }
    if ($needle.StartsWith("pid:", [System.StringComparison]::OrdinalIgnoreCase)) {
        $needle = $needle.Substring(4)
    }

    $parsedProcessId = 0
    $processes = Get-PebbleWindowProcesses
    if ([int]::TryParse($needle, [ref]$parsedProcessId)) {
        $match = $processes | Where-Object { $_.Id -eq $parsedProcessId } | Select-Object -First 1
        if ($null -ne $match) {
            Assert-PebbleProcessAllowed $match
            return $match
        }
    }

    $processNeedle = $needle
    if ($processNeedle.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processNeedle = $processNeedle.Substring(0, $processNeedle.Length - 4)
    }

    $match = $processes | Where-Object {
        $_.ProcessName -ieq $processNeedle -or
        "$($_.ProcessName).exe" -ieq $needle -or
        $_.MainWindowTitle -ieq $needle -or
        $_.MainWindowTitle -ilike "*$needle*"
    } | Select-Object -First 1
    if ($null -ne $match) {
        Assert-PebbleProcessAllowed $match
        return $match
    }

    throw "appNotFound(`"$Query`")"
}

function Assert-PebbleProcessAllowed($Process) {
    $values = @($Process.ProcessName, $Process.MainWindowTitle) | ForEach-Object { ([string]$_).ToLowerInvariant() }
    foreach ($fragment in $BlockedAppFragments) {
        foreach ($value in $values) {
            if ($value.Contains($fragment)) {
                throw "appBlocked(`"$($Process.ProcessName)`")"
            }
        }
    }
}

function Test-PebbleBrowserProcess($Process) {
    $name = ([string]$Process.ProcessName).ToLowerInvariant()
    $browserProcesses = @(
        "arc",
        "brave",
        "chrome",
        "chromium",
        "firefox",
        "librewolf",
        "msedge",
        "opera",
        "vivaldi",
        "zen"
    )
    $browserProcesses -contains $name
}

function Get-PebbleRootElement($Process) {
    if ($Process.MainWindowHandle -eq 0) {
        throw "No top-level UI Automation window is available for $($Process.ProcessName)."
    }
    [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Process.MainWindowHandle)
}

function Get-PebbleWindowFrame($Process, $RootElement) {
    $rect = New-Object PebbleDesktopWin32+RECT
    if ([PebbleDesktopWin32]::GetWindowRect([IntPtr]$Process.MainWindowHandle, [ref]$rect)) {
        return New-PebbleFrame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }

    try {
        $bounds = $RootElement.Current.BoundingRectangle
        if (-not $bounds.IsEmpty) {
            return New-PebbleFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
    } catch {}
    $null
}

function Get-PebbleWindowId($Process) {
    [int64]$Process.MainWindowHandle
}

function Get-PebbleAppName($Process) {
    if ($Process.ProcessName -eq "ApplicationFrameHost" -and -not [string]::IsNullOrWhiteSpace($Process.MainWindowTitle)) {
        return [string]$Process.MainWindowTitle
    }
    [string]$Process.ProcessName
}

function New-PebbleAppRecord($Process) {
    [pscustomobject]@{
        name = Get-PebbleAppName $Process
        bundleIdentifier = $Process.ProcessName
        bundleId = $Process.ProcessName
        pid = [int]$Process.Id
    }
}

function Assert-PebbleWindowTarget($Process, $WindowId, $WindowIndex) {
    if ($null -ne $WindowIndex -and [int]$WindowIndex -ne 0) {
        throw "windowNotFound(`"$WindowIndex`")"
    }
    if ($null -ne $WindowId -and [int64]$WindowId -ne (Get-PebbleWindowId $Process)) {
        throw "windowNotFound(`"$WindowId`")"
    }
}

function Restore-PebbleWindow($Process) {
    if ($Process.MainWindowHandle -eq 0) { return }
    [void][PebbleDesktopWin32]::ShowWindow([IntPtr]$Process.MainWindowHandle, 9)
    [void][PebbleDesktopWin32]::SetForegroundWindow([IntPtr]$Process.MainWindowHandle)
}

function Test-PebbleWindowFocused([IntPtr]$WindowHandle) {
    [PebbleDesktopWin32]::GetForegroundWindow() -eq $WindowHandle
}

function Wait-PebbleWindowFocused([IntPtr]$WindowHandle, [int]$TimeoutMilliseconds) {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (Test-PebbleWindowFocused $WindowHandle) { return $true }
        Start-Sleep -Milliseconds 50
    }
    Test-PebbleWindowFocused $WindowHandle
}

function Assert-PebbleKeyboardFocus([IntPtr]$WindowHandle, $Operation) {
    if (Test-PebbleWindowFocused $WindowHandle) { return }
    if ([bool]$Operation.restoreWindow) {
        if (Wait-PebbleWindowFocused $WindowHandle 500) { return }
        throw "window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused; bring it forward manually or check desktop permissions"
    }
    throw "window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window"
}

function Get-PebbleElementFrame($Element, $WindowFrame) {
    try {
        $bounds = $Element.Current.BoundingRectangle
        if ($bounds.IsEmpty) { return $null }
        if ($null -eq $WindowFrame) {
            return New-PebbleFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
        New-PebbleFrame ($bounds.X - $WindowFrame.x) ($bounds.Y - $WindowFrame.y) $bounds.Width $bounds.Height
    } catch {
        $null
    }
}

function Get-PebbleProperty($Element, [string]$Name) {
    try { [string]$Element.Current.$Name } catch { "" }
}

function Get-PebbleRuntimeId($Element) {
    try { @($Element.GetRuntimeId()) } catch { @() }
}

function Test-PebbleSensitiveElement($Element) {
    try {
        if ($Element.Current.IsPassword) { return $true }
    } catch {}
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $parts = @(
        (Get-PebbleProperty $Element "LocalizedControlType"),
        $controlType,
        (Get-PebbleProperty $Element "Name"),
        (Get-PebbleProperty $Element "AutomationId"),
        (Get-PebbleProperty $Element "ClassName")
    )
    $haystack = (($parts -join " ") -replace "\s+", " ").ToLowerInvariant()
    foreach ($term in @("password", "passcode", "secret", "one-time code", "verification code")) {
        if ($haystack.Contains($term)) { return $true }
    }
    $haystack -match "(^|[^a-z0-9])pin([^a-z0-9]|$)"
}

function Get-PebbleValueText($Element) {
    try {
        if (Test-PebbleSensitiveElement $Element) { return "[redacted]" }
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $rawValue = $pattern.Current.Value
        $text = if ($null -eq $rawValue) { "" } else { [string]$rawValue }
        if ($text.Length -gt $TextLimit) { return $text.Substring(0, $TextLimit) + "..." }
        $text
    } catch {
        ""
    }
}

function Get-PebbleActions($Element) {
    $actions = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $Element.GetSupportedPatterns()) {
        $name = [string]$pattern.ProgrammaticName
        if ($name -like "InvokePatternIdentifiers.Pattern") { $actions.Add("Invoke") }
        elseif ($name -like "TogglePatternIdentifiers.Pattern") { $actions.Add("Toggle") }
        elseif ($name -like "SelectionItemPatternIdentifiers.Pattern") { $actions.Add("Select") }
        elseif ($name -like "ScrollPatternIdentifiers.Pattern") { $actions.Add("Scroll") }
        elseif ($name -like "ValuePatternIdentifiers.Pattern") { $actions.Add("SetValue") }
    }
    @($actions | Select-Object -Unique)
}

function Get-PebbleMeaningfulActions($Actions) {
    $noisy = @("Invoke", "ScrollToVisible", "ShowMenu")
    @($Actions | Where-Object { $noisy -notcontains $_ })
}

function Format-PebbleSnapshotText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    (($Text -replace "\s+", " ").Trim())
}

function Format-PebbleValueSegment([string]$RoleKey, [string]$Title, [string]$Value) {
    $clean = Format-PebbleSnapshotText $Value
    if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq $Title) { return "" }
    if ($RoleKey -eq "heading" -and $clean -match "^\d+$") { return "" }
    if ($RoleKey -in @("text", "edit", "document", "scroll bar", "progress bar")) {
        return " $clean"
    }
    ", Value: $clean"
}

function Test-PebbleSuppressChildren([string]$RoleKey, [string]$Title, [string]$Value, [string]$Summary) {
    $hasCompactLabel = -not [string]::IsNullOrWhiteSpace($Title) -or -not [string]::IsNullOrWhiteSpace((Format-PebbleSnapshotText $Value)) -or -not [string]::IsNullOrWhiteSpace((Format-PebbleSnapshotText $Summary))
    $hasCompactLabel -and $RoleKey -in @(
        "button",
        "check box",
        "combo box",
        "heading",
        "hyperlink",
        "link",
        "menu item",
        "radio button",
        "tab item"
    )
}

function Get-PebbleTextSnippets($Element, [int]$Limit = 6, [int]$MaxDepth = 3) {
    $values = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]

    function Visit-PebbleText($Node, [int]$Depth) {
        if ($values.Count -ge $Limit -or $Depth -gt $MaxDepth) { return }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        if ($role -match "text|link|label") {
            foreach ($raw in @((Get-PebbleProperty $Node "Name"), (Get-PebbleValueText $Node))) {
                $value = (($raw -replace "\s+", " ").Trim())
                if (-not [string]::IsNullOrWhiteSpace($value) -and $seen.Add($value)) {
                    if ($value.Length -gt 80) { $value = $value.Substring(0, 80) + "..." }
                    $values.Add($value)
                    if ($values.Count -ge $Limit) { return }
                }
            }
        }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-PebbleText $children.Item($i) ($Depth + 1)
                if ($values.Count -ge $Limit) { return }
            }
        } catch {}
    }

    Visit-PebbleText $Element 0
    @($values.ToArray())
}

function Test-PebblePlainTextSubtree($Element, [int]$MaxDepth = 4) {
    $script:sawPebbleText = $false
    $allowed = @("pane", "group", "custom", "unknown", "text", "link", "image")

    function Visit-PebblePlainText($Node, [int]$Depth) {
        if ($Depth -gt $MaxDepth) { return $false }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        $roleKey = $role.ToLowerInvariant()
        if ($allowed -notcontains $roleKey) { return $false }
        if ($roleKey -match "text|link") { $script:sawPebbleText = $true }
        if (@(Get-PebbleMeaningfulActions @(Get-PebbleActions $Node)).Count -gt 0) { return $false }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                if (-not (Visit-PebblePlainText $children.Item($i) ($Depth + 1))) { return $false }
            }
        } catch {}
        return $true
    }

    (Visit-PebblePlainText $Element 0) -and $script:sawPebbleText
}

function New-PebbleElementRecord($Element, [int]$Index, $WindowFrame) {
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $nativeWindowHandle = try { [int64]$Element.Current.NativeWindowHandle } catch { 0 }
    [pscustomobject]@{
        index = $Index
        runtimeId = @(Get-PebbleRuntimeId $Element)
        automationId = Get-PebbleProperty $Element "AutomationId"
        name = Get-PebbleProperty $Element "Name"
        controlType = $controlType
        localizedControlType = Get-PebbleProperty $Element "LocalizedControlType"
        className = Get-PebbleProperty $Element "ClassName"
        value = Get-PebbleValueText $Element
        isSelected = Test-PebbleElementSelected $Element
        nativeWindowHandle = $nativeWindowHandle
        frame = Get-PebbleElementFrame $Element $WindowFrame
        actions = @(Get-PebbleActions $Element)
    }
}

function Test-PebbleElementSelected($Element) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        return [bool]$pattern.Current.IsSelected
    } catch {
        return $false
    }
}

function Render-PebbleTree($RootElement, $WindowFrame, [bool]$CompactBrowserTabs = $false) {
    $records = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $truncation = [pscustomobject]@{
        truncated = $false
        maxNodes = $MaxNodes
        maxDepth = $MaxDepth
        maxDepthReached = $false
    }

    function Visit-PebbleNode($Node, [int]$Depth) {
        if ($records.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) {
            $truncation.truncated = $true
            if ($Depth -gt $MaxDepth) { $truncation.maxDepthReached = $true }
            return
        }
        $identity = try { (@($Node.GetRuntimeId()) -join ".") } catch { [Guid]::NewGuid().ToString() }
        if (-not $seen.Add($identity)) { return }

        $record = New-PebbleElementRecord $Node $records.Count $WindowFrame
        $children = @()
        try {
            $children = @($Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition))
        } catch {}
        $meaningfulActions = @(Get-PebbleMeaningfulActions $record.actions)
        $title = if ([string]::IsNullOrWhiteSpace($record.name)) { $record.automationId } else { $record.name }
        $role = if ([string]::IsNullOrWhiteSpace($record.localizedControlType)) { $record.controlType } else { $record.localizedControlType }
        $roleKey = $role.ToLowerInvariant()
        $snippets = @(Get-PebbleTextSnippets $Node 8 4)
        $genericSummary = $null
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $snippets.Count -ge 2 -and (Test-PebblePlainTextSubtree $Node)) {
            $genericSummary = ($snippets -join " ")
        }
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $meaningfulActions.Count -eq 0 -and $null -eq $genericSummary -and $children.Count -le 1) {
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-PebbleNode $children.Item($i) $Depth
            }
            return
        }

        $records.Add($record)

        $line = "$($record.index) $role $(Format-PebbleSnapshotText $title)".TrimEnd()
        $line += Format-PebbleValueSegment $roleKey $title $record.value
        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -and $genericSummary -ne $title) {
            $line += ", Text: " + (Format-PebbleSnapshotText $genericSummary)
        } elseif ($roleKey -in @("row", "data item", "list item")) {
            $rowSummary = @((Get-PebbleTextSnippets $Node 6 3)) -join " "
            if (-not [string]::IsNullOrWhiteSpace($rowSummary) -and $rowSummary -ne $title) {
                $line += ", Text: " + (Format-PebbleSnapshotText $rowSummary)
            }
        }
        if ($meaningfulActions.Count -gt 0) {
            $line += ", Secondary Actions: " + ($meaningfulActions -join ", ")
        }
        $lines.Add(("`t" * $Depth) + $line)

        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -or (Test-PebbleSuppressChildren $roleKey $title $record.value $genericSummary)) { return }
        $childLineStart = $lines.Count
        for ($i = 0; $i -lt $children.Count; $i++) {
            Visit-PebbleNode $children.Item($i) ($Depth + 1)
        }
        if ($CompactBrowserTabs) {
            Compress-PebbleRenderedBrowserTabs $records $lines $childLineStart ($Depth + 1)
        }
    }

    Visit-PebbleNode $RootElement 0
    [pscustomobject]@{ elements = @($records.ToArray()); lines = @($lines.ToArray()); truncation = $truncation }
}

function Compress-PebbleRenderedBrowserTabs($Records, $Lines, [int]$StartLine, [int]$Depth) {
    $tabLineIndexes = New-Object System.Collections.Generic.List[int]
    for ($lineIndex = $StartLine; $lineIndex -lt $Lines.Count; $lineIndex++) {
        if (Test-PebbleDirectRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth) {
            $tabLineIndexes.Add($lineIndex)
        }
    }
    if ($tabLineIndexes.Count -lt 10) { return }

    $recordsByIndex = @{}
    foreach ($record in @($Records.ToArray())) {
        $recordsByIndex[[int]$record.index] = $record
    }
    $activeLineIndexes = New-Object System.Collections.Generic.HashSet[int]
    foreach ($lineIndex in $tabLineIndexes) {
        if (Test-PebbleActiveRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth $recordsByIndex) {
            [void]$activeLineIndexes.Add($lineIndex)
        }
    }
    if ($activeLineIndexes.Count -eq 0) { return }

    $omittedRecordIndexes = New-Object System.Collections.Generic.HashSet[int]
    $omittedCount = 0
    $insertionIndex = $tabLineIndexes[0]
    for ($i = $tabLineIndexes.Count - 1; $i -ge 0; $i--) {
        $lineIndex = $tabLineIndexes[$i]
        if ($activeLineIndexes.Contains($lineIndex)) { continue }
        $recordIndex = Get-PebbleRenderedElementIndex ([string]$Lines[$lineIndex]) $Depth
        if ($null -ne $recordIndex) {
            [void]$omittedRecordIndexes.Add([int]$recordIndex)
        }
        $Lines.RemoveAt($lineIndex)
        $omittedCount++
    }
    if ($omittedCount -le 0) { return }
    for ($recordIndex = $Records.Count - 1; $recordIndex -ge 0; $recordIndex--) {
        if ($omittedRecordIndexes.Contains([int]$Records[$recordIndex].index)) {
            $Records.RemoveAt($recordIndex)
        }
    }
    $Lines.Insert($insertionIndex, (("`t" * $Depth) + "... $omittedCount inactive browser tabs omitted"))
}

function Test-PebbleDirectRenderedBrowserTabLine([string]$Line, [int]$Depth) {
    $indent = "`t" * $Depth
    if (-not $Line.StartsWith($indent)) { return $false }
    $text = $Line.Substring($indent.Length)
    if ($text.StartsWith("`t")) { return $false }
    $text -match "^\d+ (page tab|tab item|tab)($|[ \(,])"
}

function Test-PebbleActiveRenderedBrowserTabLine([string]$Line, [int]$Depth, $RecordsByIndex) {
    if ($Line.Contains("(selected")) { return $true }
    $recordIndex = Get-PebbleRenderedElementIndex $Line $Depth
    if ($null -eq $recordIndex -or -not $RecordsByIndex.ContainsKey([int]$recordIndex)) { return $false }
    $record = $RecordsByIndex[[int]$recordIndex]
    [bool]$record.isSelected -or (Format-PebbleSnapshotText $record.value) -eq "1"
}

function Get-PebbleRenderedElementIndex([string]$Line, [int]$Depth) {
    $text = $Line.Substring(("`t" * $Depth).Length)
    if ($text -match "^(\d+)") { return [int]$Matches[1] }
    $null
}

function ConvertTo-PebblePngBytes([System.Drawing.Image]$Image) {
    $stream = $null
    try {
        $stream = New-Object System.IO.MemoryStream
        $Image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function New-PebbleScreenshotPayload([byte[]]$Bytes, [int]$Width, [int]$Height, [double]$Scale) {
    [pscustomobject]@{
        base64 = [Convert]::ToBase64String($Bytes)
        width = $Width
        height = $Height
        scale = $Scale
    }
}

function Resize-PebbleBitmap([System.Drawing.Bitmap]$Source, [int]$Width, [int]$Height) {
    $resized = $null
    $graphics = $null
    try {
        $resized = New-Object System.Drawing.Bitmap $Width, $Height
        $graphics = [System.Drawing.Graphics]::FromImage($resized)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $graphics.DrawImage($Source, 0, 0, $Width, $Height)
        $result = $resized
        $resized = $null
        return $result
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $resized) { $resized.Dispose() }
    }
}

function Get-PebbleBoundedScreenshotPayload([System.Drawing.Bitmap]$Bitmap) {
    $originalWidth = [int][Math]::Max(1, $Bitmap.Width)
    $originalHeight = [int][Math]::Max(1, $Bitmap.Height)
    $pngBytes = ConvertTo-PebblePngBytes $Bitmap
    if ($pngBytes.Length -le $MaxScreenshotPngBytes) {
        return New-PebbleScreenshotPayload $pngBytes $originalWidth $originalHeight 1.0
    }

    # Why: screenshots cross process boundaries as PNG base64 in JSON; cap noisy
    # large-window payloads to match the macOS provider's memory bounds.
    $scale = [Math]::Min(1.0, $MaxScreenshotEdge / [double][Math]::Max($originalWidth, $originalHeight))
    while ($scale -ge $MinScreenshotScale) {
        $width = [int][Math]::Max(1, [Math]::Round($originalWidth * $scale))
        $height = [int][Math]::Max(1, [Math]::Round($originalHeight * $scale))
        if ($width -eq $originalWidth -and $height -eq $originalHeight) {
            $scale *= $ScreenshotScaleStep
            continue
        }

        $resized = $null
        try {
            $resized = Resize-PebbleBitmap $Bitmap $width $height
            $candidateBytes = ConvertTo-PebblePngBytes $resized
            if ($candidateBytes.Length -le $MaxScreenshotPngBytes) {
                return New-PebbleScreenshotPayload $candidateBytes $width $height ($width / [double]$originalWidth)
            }
        } finally {
            if ($null -ne $resized) { $resized.Dispose() }
        }

        $scale *= $ScreenshotScaleStep
    }

    [pscustomobject]@{
        error = [pscustomobject]@{
            code = "screenshot_failed"
            message = "screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window"
        }
    }
}

function Get-PebbleScreenshot([bool]$IncludeScreenshot, $WindowFrame) {
    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }
    $bitmap = $null
    $graphics = $null
    try {
        $width = [int][Math]::Max(1, [Math]::Round($WindowFrame.width))
        $height = [int][Math]::Max(1, [Math]::Round($WindowFrame.height))
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int][Math]::Round($WindowFrame.x), [int][Math]::Round($WindowFrame.y), 0, 0, $bitmap.Size)
        Get-PebbleBoundedScreenshotPayload $bitmap
    } catch {
        $null
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function New-PebbleSnapshot([string]$Query, [bool]$IncludeScreenshot, $WindowId = $null, $WindowIndex = $null, [bool]$RestoreWindow = $false) {
    $process = Find-PebbleProcess $Query
    if ($RestoreWindow) { Restore-PebbleWindow $process }
    Assert-PebbleWindowTarget $process $WindowId $WindowIndex
    $root = Get-PebbleRootElement $process
    $windowFrame = Get-PebbleWindowFrame $process $root
    $tree = Render-PebbleTree $root $windowFrame (Test-PebbleBrowserProcess $process)
    $screenshot = Get-PebbleScreenshot $IncludeScreenshot $windowFrame

    [pscustomobject]@{
        snapshotId = [guid]::NewGuid().ToString()
        app = New-PebbleAppRecord $process
        windowTitle = $process.MainWindowTitle
        windowId = Get-PebbleWindowId $process
        windowBounds = $windowFrame
        screenshotPngBase64 = if ($null -ne $screenshot) { $screenshot.base64 } else { $null }
        screenshotWidth = if ($null -ne $screenshot) { $screenshot.width } else { $null }
        screenshotHeight = if ($null -ne $screenshot) { $screenshot.height } else { $null }
        screenshotScale = if ($null -ne $screenshot) { $screenshot.scale } else { $null }
        screenshotError = if ($null -ne $screenshot) { $screenshot.error } else { $null }
        coordinateSpace = "window"
        truncation = $tree.truncation
        treeLines = @($tree.lines)
        focusedSummary = $null
        focusedElementId = $null
        selectedText = $null
        elements = @($tree.elements)
    }
}

function Get-PebbleAppList {
    @(Get-PebbleWindowProcesses | ForEach-Object {
        New-PebbleAppRecord $_
    })
}

function Get-PebbleWindowList([string]$Query) {
    $process = Find-PebbleProcess $Query
    $root = Get-PebbleRootElement $process
    $windowFrame = Get-PebbleWindowFrame $process $root
    $x = $null
    $y = $null
    $width = 0
    $height = 0
    if ($null -ne $windowFrame) {
        $x = [int][Math]::Round($windowFrame.x)
        $y = [int][Math]::Round($windowFrame.y)
        $width = [int][Math]::Max(0, [Math]::Round($windowFrame.width))
        $height = [int][Math]::Max(0, [Math]::Round($windowFrame.height))
    }
    $app = New-PebbleAppRecord $process
    [pscustomobject]@{
        app = $app
        windows = @([pscustomobject]@{
            index = 0
            app = $app
            id = Get-PebbleWindowId $process
            title = $process.MainWindowTitle
            x = $x
            y = $y
            width = $width
            height = $height
            isMinimized = $false
            isOffscreen = $false
            screenIndex = $null
            platform = [pscustomobject]@{ backend = "uia"; nativeWindowHandle = Get-PebbleWindowId $process }
        })
    }
}

function Get-PebbleHandshake {
    [pscustomobject]@{
        platform = "win32"
        provider = "pebble-computer-use-windows"
        providerVersion = "1.0.0"
        protocolVersion = 1
        supports = [pscustomobject]@{
            apps = [pscustomobject]@{ list = $true; bundleIds = $false; pids = $true }
            windows = [pscustomobject]@{ list = $true; targetById = $true; targetByIndex = $true; focus = $false; moveResize = $false }
            observation = [pscustomobject]@{ screenshot = $true; annotatedScreenshot = $false; elementFrames = $true; ocr = $false }
            actions = [pscustomobject]@{
                click = $true
                typeText = $true
                pressKey = $true
                hotkey = $true
                pasteText = $true
                scroll = $true
                drag = $true
                setValue = $true
                performAction = $true
            }
            surfaces = [pscustomobject]@{ menus = $false; dialogs = $false; dock = $false; menubar = $false }
        }
    }
}

function Test-PebbleSameRuntimeId($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
    for ($i = 0; $i -lt $Left.Count; $i++) {
        if ([int]$Left[$i] -ne [int]$Right[$i]) { return $false }
    }
    $true
}

function Find-PebbleElement($RootElement, $Record) {
    if ($null -eq $Record) { return $null }
    if ($Record.index -eq 0) { return $RootElement }

    try {
        $descendants = $RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) {
            $candidate = $descendants.Item($i)
            if (Test-PebbleSameRuntimeId @($candidate.GetRuntimeId()) @($Record.runtimeId)) {
                return $candidate
            }
        }
    } catch {}
    $null
}

function Invoke-PebblePrimaryAction($Element) {
    foreach ($pattern in @(
        [Windows.Automation.InvokePattern]::Pattern,
        [Windows.Automation.SelectionItemPattern]::Pattern,
        [Windows.Automation.TogglePattern]::Pattern
    )) {
        try {
            $instance = $Element.GetCurrentPattern($pattern)
            if ($pattern -eq [Windows.Automation.InvokePattern]::Pattern) { $instance.Invoke(); return $true }
            if ($pattern -eq [Windows.Automation.SelectionItemPattern]::Pattern) { $instance.Select(); return $true }
            if ($pattern -eq [Windows.Automation.TogglePattern]::Pattern) { $instance.Toggle(); return $true }
        } catch {}
    }
    $false
}

function Invoke-PebbleNamedAction($Element, [string]$Action) {
    $wanted = ""
    if ($null -ne $Action) { $wanted = $Action.Trim().ToLowerInvariant() }
    switch ($wanted) {
        "invoke" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
            return $true
        }
        "select" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
            $pattern.Select()
            return $true
        }
        "toggle" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            $pattern.Toggle()
            return $true
        }
        default {
            return $false
        }
    }
}

function Set-PebbleElementValue($Element, [string]$Value) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if (-not $pattern.Current.IsReadOnly) {
            $pattern.SetValue($Value)
            return $true
        }
    } catch {}
    $false
}

function Get-PebbleRequiredNumber($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Name must be a finite number"
    }
    $number
}

function Get-PebblePositiveInteger($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = [int]$Value
    if ($number -le 0) { throw "$Name must be a positive integer" }
    $number
}

function Get-PebblePositiveNumber($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = Get-PebbleRequiredNumber $Value $Name
    if ($number -le 0) { throw "$Name must be a positive number" }
    $number
}

function Get-PebbleRequiredString($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $text = [string]$Value
    if ($text.Length -eq 0) { throw "$Name is required" }
    $text
}

function Get-PebbleScreenPoint($Operation, $WindowFrame) {
    if ($null -ne $Operation.element) {
        throw "stale element frame; run get-app-state again and use a fresh element index"
    }
    $x = Get-PebbleRequiredNumber $Operation.x "x"
    $y = Get-PebbleRequiredNumber $Operation.y "y"
    @{
        x = [int][Math]::Round($WindowFrame.x + $x)
        y = [int][Math]::Round($WindowFrame.y + $y)
    }
}

function Get-PebbleElementScreenPoint($Element) {
    if ($null -eq $Element) { return $null }
    try {
        $rect = $Element.Current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
            return @{
                x = [int][Math]::Round($rect.X + ($rect.Width / 2))
                y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
            }
        }
    } catch {}
    $null
}

function Send-PebbleMouseClick([IntPtr]$WindowHandle, [int]$ScreenX, [int]$ScreenY, [string]$Button, [int]$Count) {
    [void][PebbleDesktopWin32]::SetForegroundWindow($WindowHandle)
    [void][PebbleDesktopWin32]::SetCursorPos($ScreenX, $ScreenY)
    $buttonName = if ([string]::IsNullOrWhiteSpace($Button)) { "left" } else { $Button.ToLowerInvariant() }
    switch ($buttonName) {
        "left" { $down = $MouseEvents.LeftDown; $up = $MouseEvents.LeftUp }
        "right" { $down = $MouseEvents.RightDown; $up = $MouseEvents.RightUp }
        "middle" { $down = $MouseEvents.MiddleDown; $up = $MouseEvents.MiddleUp }
        default { throw "unsupported mouse button: $Button" }
    }

    for ($i = 0; $i -lt (Get-PebblePositiveInteger $Count "click_count"); $i++) {
        [PebbleDesktopWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 35
        [PebbleDesktopWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    }
}

function Send-PebbleDrag([IntPtr]$WindowHandle, $From, $To) {
    [void][PebbleDesktopWin32]::SetForegroundWindow($WindowHandle)
    $startX = [int]$From.x
    $startY = [int]$From.y
    $endX = [int]$To.x
    $endY = [int]$To.y
    [void][PebbleDesktopWin32]::SetCursorPos($startX, $startY)
    [PebbleDesktopWin32]::mouse_event($MouseEvents.LeftDown, 0, 0, 0, [UIntPtr]::Zero)
    for ($step = 1; $step -le 12; $step++) {
        $x = [int][Math]::Round($startX + (($endX - $startX) * $step / 12))
        $y = [int][Math]::Round($startY + (($endY - $startY) * $step / 12))
        [void][PebbleDesktopWin32]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
    }
    [PebbleDesktopWin32]::mouse_event($MouseEvents.LeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-PebbleText([IntPtr]$WindowHandle, [string]$Text) {
    [void][PebbleDesktopWin32]::SetForegroundWindow($WindowHandle)
    $hasNonAscii = $false
    foreach ($character in $Text.ToCharArray()) {
        if ([int][char]$character -gt 0x7F) { $hasNonAscii = $true; break }
    }
    if ($hasNonAscii) {
        foreach ($character in $Text.ToCharArray()) {
            [void][PebbleDesktopWin32]::PostMessage($WindowHandle, $WindowsMessages.Char, [IntPtr][int][char]$character, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 8
        }
        return
    }
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-PebbleSendKeysText $Text))
}

function Get-PebbleVirtualKey([string]$Key) {
    $normalized = $Key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "delete" = 0x2E; "space" = 0x20; "left" = 0x25
        "up" = 0x26; "right" = 0x27; "down" = 0x28; "home" = 0x24; "end" = 0x23
    }
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized.Length -eq 1) { return [int][char]$normalized.ToUpperInvariant()[0] }
    throw "Unsupported key: $Key"
}

function Send-PebbleKey([IntPtr]$WindowHandle, [string]$Key) {
    [void][PebbleDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-PebbleSendKeysKey $Key))
}

function Get-PebbleModifierVirtualKey([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return 0x11 }
        { $_ -in @("shift") } { return 0x10 }
        { $_ -in @("alt", "option") } { return 0x12 }
        { $_ -in @("meta", "super", "win", "cmd", "command") } { return 0x5B }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Send-PebbleHotkey([IntPtr]$WindowHandle, [string]$KeySpec) {
    $parts = @($KeySpec.Split("+") | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) { throw "Unsupported key: $KeySpec" }
    $key = $parts[$parts.Count - 1]
    $prefix = ""
    if ($parts.Count -gt 1) {
        foreach ($modifier in $parts[0..($parts.Count - 2)]) {
            $prefix += ConvertTo-PebbleSendKeysModifier $modifier
        }
    }
    [void][PebbleDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait($prefix + (ConvertTo-PebbleSendKeysKey $key))
}

function ConvertTo-PebbleSendKeysText([string]$Text) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $Text.ToCharArray()) {
        $value = [string]$character
        if ($value -eq "`r") { continue }
        if ($value -eq "`n") { [void]$builder.Append("{ENTER}"); continue }
        if ("+^%~(){}[]".Contains($value)) {
            [void]$builder.Append("{").Append($value).Append("}")
        } else {
            [void]$builder.Append($value)
        }
    }
    $builder.ToString()
}

function ConvertTo-PebbleSendKeysKey([string]$Key) {
    switch ($Key.ToLowerInvariant()) {
        { $_ -in @("return", "enter") } { return "{ENTER}" }
        "tab" { return "{TAB}" }
        { $_ -in @("escape", "esc") } { return "{ESC}" }
        "backspace" { return "{BACKSPACE}" }
        "delete" { return "{DELETE}" }
        "space" { return " " }
        "left" { return "{LEFT}" }
        "up" { return "{UP}" }
        "right" { return "{RIGHT}" }
        "down" { return "{DOWN}" }
        "home" { return "{HOME}" }
        "end" { return "{END}" }
        { $_ -in @("pageup", "page_up") } { return "{PGUP}" }
        { $_ -in @("pagedown", "page_down") } { return "{PGDN}" }
        "insert" { return "{INSERT}" }
        default {
            if ($Key.Length -eq 1) { return (ConvertTo-PebbleSendKeysText $Key) }
            throw "Unsupported key: $Key"
        }
    }
}

function ConvertTo-PebbleSendKeysModifier([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return "^" }
        "shift" { return "+" }
        { $_ -in @("alt", "option") } { return "%" }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Send-PebblePasteText([IntPtr]$WindowHandle, [string]$Text) {
    $previous = $null
    $hadPrevious = $false
    try { $previous = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
    $hadPrevious = $null -ne $previous
    try {
        Set-Clipboard -Value $Text
        Send-PebbleHotkey $WindowHandle "Ctrl+v"
    } finally {
        if ($hadPrevious) {
            try { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true) } catch {}
        } else {
            try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
        }
    }
}

function Invoke-PebbleOperation($Operation) {
    $includeScreenshot = -not [bool]$Operation.noScreenshot
    if ($Operation.tool -eq "handshake") {
        return [pscustomobject]@{ ok = $true; capabilities = Get-PebbleHandshake }
    }
    if ($Operation.tool -eq "list_apps") {
        return [pscustomobject]@{ ok = $true; apps = @(Get-PebbleAppList) }
    }
    if ($Operation.tool -eq "list_windows") {
        $list = Get-PebbleWindowList $Operation.app
        return [pscustomobject]@{ ok = $true; app = $list.app; windows = @($list.windows) }
    }
    if ($Operation.tool -eq "get_app_state") {
        return [pscustomobject]@{ ok = $true; snapshot = New-PebbleSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex ([bool]$Operation.restoreWindow) }
    }

    $process = Find-PebbleProcess $Operation.app
    if ([bool]$Operation.restoreWindow) { Restore-PebbleWindow $process }
    Assert-PebbleWindowTarget $process $Operation.windowId $Operation.windowIndex
    $root = Get-PebbleRootElement $process
    $windowFrame = if ($null -ne $Operation.windowBounds) { $Operation.windowBounds } else { Get-PebbleWindowFrame $process $root }
    $element = Find-PebbleElement $root $Operation.element
    $fromElement = Find-PebbleElement $root $Operation.fromElement
    $toElement = Find-PebbleElement $root $Operation.toElement
    $handle = [IntPtr]$process.MainWindowHandle
    if ($Operation.tool -in @("type_text", "press_key", "hotkey", "paste_text")) {
        Assert-PebbleKeyboardFocus $handle $Operation
    }
    $action = $null

    switch ($Operation.tool) {
        "click" {
            # Why: agents expect a click into a target app to make the next
            # keyboard action safe, even when UI Automation handles the click.
            Restore-PebbleWindow $process
            $handledByPattern = $false
            $clickCount = Get-PebblePositiveInteger $Operation.click_count "click_count"
            if ($null -ne $element -and $Operation.mouse_button -ne "right" -and $Operation.mouse_button -ne "middle" -and $clickCount -le 1) {
                $handledByPattern = Invoke-PebblePrimaryAction $element
            }
            if (-not $handledByPattern) {
                $point = Get-PebbleElementScreenPoint $element
                if ($null -eq $point) { $point = Get-PebbleScreenPoint $Operation $windowFrame }
                Send-PebbleMouseClick $handle $point.x $point.y $Operation.mouse_button $clickCount
                $action = [pscustomobject]@{ path = "synthetic"; actionName = $null; fallbackReason = "actionUnsupported" }
            } else {
                $action = [pscustomobject]@{ path = "accessibility"; actionName = "primaryAction"; fallbackReason = $null }
            }
        }
        "perform_secondary_action" {
            if ($null -eq $element) { throw "unknown element_index" }
            if (-not (Invoke-PebbleNamedAction $element $Operation.action)) {
                throw "$($Operation.action) is not a valid secondary action"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = $Operation.action; fallbackReason = $null }
        }
        "scroll" {
            $delta = 120 * [int][Math]::Ceiling((Get-PebblePositiveNumber $Operation.pages "pages"))
            if ($Operation.direction -eq "down" -or $Operation.direction -eq "right") {
                $delta = -1 * $delta
            } elseif ($Operation.direction -ne "up" -and $Operation.direction -ne "left") {
                throw "unsupported scroll direction: $($Operation.direction)"
            }
            $point = Get-PebbleElementScreenPoint $element
            if ($null -eq $point) { $point = Get-PebbleScreenPoint $Operation $windowFrame }
            [void][PebbleDesktopWin32]::SetForegroundWindow($handle)
            [void][PebbleDesktopWin32]::SetCursorPos([int]$point.x, [int]$point.y)
            [PebbleDesktopWin32]::mouse_event($MouseEvents.Wheel, 0, 0, $delta, [UIntPtr]::Zero)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "scroll"; fallbackReason = $null }
        }
        "drag" {
            $from = Get-PebbleElementScreenPoint $fromElement
            if ($null -eq $from -and $null -ne $Operation.fromElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $from) {
                $from = @{
                    x = $windowFrame.x + (Get-PebbleRequiredNumber $Operation.from_x "from_x")
                    y = $windowFrame.y + (Get-PebbleRequiredNumber $Operation.from_y "from_y")
                }
            }
            $to = Get-PebbleElementScreenPoint $toElement
            if ($null -eq $to -and $null -ne $Operation.toElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $to) {
                $to = @{
                    x = $windowFrame.x + (Get-PebbleRequiredNumber $Operation.to_x "to_x")
                    y = $windowFrame.y + (Get-PebbleRequiredNumber $Operation.to_y "to_y")
                }
            }
            Send-PebbleDrag $handle $from $to
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "drag"; fallbackReason = $null }
        }
        "type_text" {
            Send-PebbleText $handle (Get-PebbleRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "typeText"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "press_key" {
            Send-PebbleKey $handle (Get-PebbleRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "pressKey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "hotkey" {
            Send-PebbleHotkey $handle (Get-PebbleRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "hotkey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "paste_text" {
            Send-PebblePasteText $handle (Get-PebbleRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "clipboard"; actionName = "paste"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "clipboard_paste" } }
        }
        "set_value" {
            if ($null -eq $element -or -not (Set-PebbleElementValue $element ([string]$Operation.value))) {
                throw "element value is not settable"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = "setValue"; fallbackReason = $null }
        }
        default {
            throw "unsupported tool: $($Operation.tool)"
        }
    }

    try {
        $snapshot = New-PebbleSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex
    } catch {
        if ($null -eq $Operation.windowId -and $null -eq $Operation.windowIndex) { throw }
        if ($null -eq $action.verification) {
            $action | Add-Member -NotePropertyName verification -NotePropertyValue ([pscustomobject]@{ state = "unverified"; reason = "window_changed" })
        }
        $snapshot = New-PebbleSnapshot $Operation.app $includeScreenshot $null $null
    }
    [pscustomobject]@{ ok = $true; action = $action; snapshot = $snapshot }
}

try {
    $operation = Read-PebbleOperation $OperationPath
    Write-PebbleJson (Invoke-PebbleOperation $operation)
} catch {
    Write-PebbleJson ([pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message })
}
