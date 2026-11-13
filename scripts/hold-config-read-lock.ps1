# Private stdin protocol for config-read-lock.ts. Never pass config paths on the command line.
# No config content is read, copied or emitted, and no child process, ACL or persistent policy is changed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'

$streams = [System.Collections.Generic.List[System.IO.FileStream]]::new()
$stage = 'validate'
$code = 'invalid-input'
$fileIndex = -1
$ready = $false
$failed = $false

function Read-BoundedLine([int] $limit) {
    $builder = [System.Text.StringBuilder]::new()
    while ($true) {
        $value = [Console]::In.Read()
        if ($value -eq -1) {
            if ($builder.Length -eq 0) { return $null }
            throw [System.IO.InvalidDataException]::new()
        }
        if ($value -eq 10) { return $builder.ToString().TrimEnd([char] 13) }
        if ($builder.Length -ge $limit) { throw [System.IO.InvalidDataException]::new() }
        $null = $builder.Append([char] $value)
    }
}

function Assert-RegularPath([string] $file) {
    # Check every ancestor too: following a directory junction would not protect the requested path.
    $leaf = $true
    $current = $file
    while ($null -ne $current) {
        $attributes = [System.IO.File]::GetAttributes($current)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($attributes -band [System.IO.FileAttributes]::Device) -ne 0) {
            $script:code = 'unsafe-path'
            throw [System.IO.InvalidDataException]::new()
        }
        $directory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        if (($leaf -and $directory) -or (-not $leaf -and -not $directory)) {
            $script:code = 'unsafe-path'
            throw [System.IO.InvalidDataException]::new()
        }
        $leaf = $false
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent) { $current = $null } else { $current = $parent.FullName }
    }
}

try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    # Import only the system module by absolute path; never discover modules from HOME or cwd.
    Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
    $line = Read-BoundedLine 65536
    if ($null -eq $line -or [System.Text.Encoding]::UTF8.GetByteCount($line) -gt 65535) {
        throw [System.IO.InvalidDataException]::new()
    }
    $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    if ($null -eq $request -or $request -is [Array]) { throw [System.IO.InvalidDataException]::new() }
    $keys = @($request.PSObject.Properties.Name)
    if ($keys.Count -ne 2 -or -not ($keys -contains 'protocol') -or -not ($keys -contains 'files') -or
        $request.protocol -cne 1 -or -not ($request.files -is [Array]) -or
        $request.files.Count -lt 1 -or $request.files.Count -gt 32) {
        throw [System.IO.InvalidDataException]::new()
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($value in $request.files) {
        $fileIndex = $paths.Count
        $code = 'unsafe-path'
        if (-not ($value -is [string]) -or $value.Length -gt 1024 -or
            $value -notmatch '^[a-zA-Z]:[\\/]' -or $value -match '[\x00-\x1f<>"|?*]' -or $value.Substring(2).Contains(':')) {
            throw [System.IO.InvalidDataException]::new()
        }
        $file = $value.Replace('/', '\')
        foreach ($part in $file.Substring(3).Split([char] 92)) {
            if ($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or
                $part -match '^(?i:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
                throw [System.IO.InvalidDataException]::new()
            }
        }
        if (-not $seen.Add($file)) { $code = 'invalid-input'; throw [System.IO.InvalidDataException]::new() }
        $code = 'file-unavailable'
        Assert-RegularPath $file
        $null = $paths.Add($file)
    }
    $stage = 'acquire'
    for ($fileIndex = 0; $fileIndex -lt $paths.Count; $fileIndex++) {
        $code = 'file-unavailable'
        Assert-RegularPath $paths[$fileIndex]
        $code = 'open-failed'
        # FileMode.Open only: missing files never get created. FileShare.Read denies BOTH write/delete,
        # so direct writes, truncation, renames and atomic replacement fail while readers still work.
        $stream = [System.IO.FileStream]::new($paths[$fileIndex], [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $null = $streams.Add($stream)
    }
    for ($fileIndex = 0; $fileIndex -lt $paths.Count; $fileIndex++) {
        $code = 'file-unavailable'
        Assert-RegularPath $paths[$fileIndex]
    }
    $fileIndex = -1
    $stage = 'held'
    $code = 'protocol-error'
    [Console]::Out.WriteLine('{"protocol":1,"status":"ready","fileCount":' + $streams.Count + '}')
    [Console]::Out.Flush()
    $ready = $true
    # Parent abort/release closes stdin; parent death also closes the pipe (no descendants inherit it).
    # Input is bounded even after readiness. Any command other than release invalidates the holder.
    $command = Read-BoundedLine 16
    if ($null -ne $command -and $command -cne 'release') { throw [System.IO.InvalidDataException]::new() }
}
catch {
    $failed = $true
    # Fixed vocabulary only. Never emit exception text, native error messages, paths or contents.
    if (-not $ready) {
        $index = if ($fileIndex -lt 0) { 'null' } else { [string] $fileIndex }
        try {
            [Console]::Out.WriteLine('{"protocol":1,"status":"error","stage":"' + $stage + '","code":"' + $code + '","fileIndex":' + $index + '}')
            [Console]::Out.Flush()
        } catch { }
    }
}
finally {
    for ($index = $streams.Count - 1; $index -ge 0; $index--) {
        try { $streams[$index].Dispose() } catch { $failed = $true }
    }
}
if ($failed) { exit 1 }
exit 0
