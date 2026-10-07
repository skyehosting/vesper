# Vesper Windows voice host (07 E5 S2). One persistent process; JSON lines on stdin → JSON lines on stdout.
# Requests: {"id":1,"op":"voices"}  |  {"id":2,"op":"speak","text":"…","voice":"Microsoft Zira","rate":1.0,"pitch":1.0,"volume":1.0,"out":"C:\\…\\x.wav"}
# Replies:  {"id":1,"ok":true,"voices":[…]} | {"id":2,"ok":true,"out":"…","bytes":n,"durationMs":n,"words":[{"text","startMs","durMs","pos","end"}]}
#           {"id":n,"ok":false,"error":"…"}
# Exits when stdin closes (the parent died or closed the pipe), so no orphaned powershell.exe stays behind.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Options.IncludeWordBoundaryMetadata = $true

function Reply($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 5 -Compress)); [Console]::Out.Flush() }

Reply @{ id = 0; ok = $true; ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }          # stdin closed → exit
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'voices' {
        $list = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { @{ id = $_.Id; name = $_.DisplayName; language = $_.Language; gender = "$($_.Gender)" } })
        Reply @{ id = $id; ok = $true; voices = $list }
      }
      'speak' {
        $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $req.voice -or $_.Id -eq $req.voice } | Select-Object -First 1
        if (-not $v) { $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }
        $synth.Voice = $v
        # Options persist on the synthesizer: set every one per request so one reply's tone never leaks into the next.
        $synth.Options.SpeakingRate = $(if ($req.rate) { [double]$req.rate } else { 1.0 })
        $synth.Options.AudioPitch = $(if ($req.pitch) { [double]$req.pitch } else { 1.0 })
        $synth.Options.AudioVolume = $(if ($req.volume) { [double]$req.volume } else { 1.0 })
        $stream = Await ($synth.SynthesizeTextToStreamAsync([string]$req.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
        $size = [uint32]$stream.Size
        $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
        [void](Await ($reader.LoadAsync($size)) ([uint32]))
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        [IO.File]::WriteAllBytes([string]$req.out, $bytes)
        $words = @()
        foreach ($track in $stream.TimedMetadataTracks) {
          foreach ($c in $track.Cues) { $words += @{ text = $c.Text; startMs = [int]$c.StartTime.TotalMilliseconds; durMs = [int]$c.Duration.TotalMilliseconds; pos = $c.StartPositionInInput; end = $c.EndPositionInInput } }
        }
        $reader.Dispose(); $stream.Dispose()
        Reply @{ id = $id; ok = $true; out = $req.out; bytes = $size; words = $words }
      }
      'ping' { Reply @{ id = $id; ok = $true } }
      default { Reply @{ id = $id; ok = $false; error = "unknown op" } }
    }
  } catch {
    Reply @{ id = $id; ok = $false; error = "$($_.Exception.Message)" }
  }
}
