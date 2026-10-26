# 用 Windows 自带的 OCR（Windows.Media.Ocr）识别图片里的文字，按行输出到 stdout（UTF-8）。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <图片绝对路径>
# 需要 Windows PowerShell 5.1（pwsh 7 没有 WinRT 投影）和简体中文 OCR 语言包。
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw '没有可用的 OCR 语言包' }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

# 超过引擎上限的大图按比例缩小
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$w = $decoder.PixelWidth; $h = $decoder.PixelHeight
if ($w -gt $max -or $h -gt $max) {
  $scale = $max / [Math]::Max($w, $h)
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.ScaledWidth = [uint32][Math]::Floor($w * $scale)
  $transform.ScaledHeight = [uint32][Math]::Floor($h * $scale)
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
} else {
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()

# 中文识别结果每个字之间带空格：相邻两个词都是中日韩字符或全角标点时去掉空格
$cjk = '[⺀-鿿豈-﫿＀-￯　-〿]'
foreach ($line in $result.Lines) {
  $text = ''
  $prev = ''
  foreach ($word in $line.Words) {
    $t = $word.Text
    if ($text -ne '' -and -not ($prev -match "$cjk$" -and $t -match "^$cjk")) { $text += ' ' }
    $text += $t
    $prev = $t
  }
  if ($text.Trim()) { [Console]::WriteLine($text) }
}
