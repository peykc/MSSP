param(
  [string]$PublicDir = (Join-Path $PSScriptRoot "..\public")
)

Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path (Join-Path $PublicDir "assets\brand") | Out-Null

$fontCollection = [System.Drawing.Text.PrivateFontCollection]::new()
$fontCollection.AddFontFile((Join-Path $PSScriptRoot "fonts\LibertinusMono-Regular.ttf"))
$fontFamily = $fontCollection.Families[0]
$inkColor = [System.Drawing.ColorTranslator]::FromHtml("#f8f2ec")
$backgroundColor = [System.Drawing.ColorTranslator]::FromHtml("#171514")

function New-MarkSource {
  $canvas = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $font = [System.Drawing.Font]::new($fontFamily, 430, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new($inkColor)
  $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

  $graphics.DrawString("MS", $font, $brush, [System.Drawing.PointF]::new(512, 20), $format)
  $graphics.DrawString("SP", $font, $brush, [System.Drawing.PointF]::new(512, 350), $format)

  $format.Dispose()
  $brush.Dispose()
  $font.Dispose()
  $graphics.Dispose()

  $left = $canvas.Width
  $top = $canvas.Height
  $right = 0
  $bottom = 0
  for ($y = 0; $y -lt $canvas.Height; $y++) {
    for ($x = 0; $x -lt $canvas.Width; $x++) {
      if ($canvas.GetPixel($x, $y).A -eq 0) { continue }
      if ($x -lt $left) { $left = $x }
      if ($x -gt $right) { $right = $x }
      if ($y -lt $top) { $top = $y }
      if ($y -gt $bottom) { $bottom = $y }
    }
  }

  $bounds = [System.Drawing.Rectangle]::new($left, $top, $right - $left + 1, $bottom - $top + 1)
  $mark = $canvas.Clone($bounds, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $canvas.Dispose()
  return $mark
}

function New-BrandBitmap {
  param(
    [System.Drawing.Bitmap]$Mark,
    [int]$Size,
    [bool]$Transparent
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear($(if ($Transparent) { [System.Drawing.Color]::Transparent } else { $backgroundColor }))

  $available = $Size * 0.84
  $scale = [Math]::Min($available / $Mark.Width, $available / $Mark.Height)
  $width = [single]($Mark.Width * $scale)
  $height = [single]($Mark.Height * $scale)
  $x = [single](($Size - $width) / 2)
  $y = [single](($Size - $height) / 2)
  $graphics.DrawImage($Mark, $x, $y, $width, $height)
  $graphics.Dispose()
  return $bitmap
}

function Save-Png {
  param(
    [System.Drawing.Bitmap]$Mark,
    [int]$Size,
    [string]$Path,
    [bool]$Transparent = $false
  )

  $bitmap = New-BrandBitmap -Mark $Mark -Size $Size -Transparent $Transparent
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

$mark = New-MarkSource
Save-Png -Mark $mark -Size 256 -Path (Join-Path $PublicDir "assets\brand\mssp-mark.png") -Transparent $true
Save-Png -Mark $mark -Size 16 -Path (Join-Path $PublicDir "favicon-16x16.png")
Save-Png -Mark $mark -Size 32 -Path (Join-Path $PublicDir "favicon-32x32.png")
Save-Png -Mark $mark -Size 180 -Path (Join-Path $PublicDir "apple-touch-icon.png")
Save-Png -Mark $mark -Size 192 -Path (Join-Path $PublicDir "android-chrome-192x192.png")
Save-Png -Mark $mark -Size 512 -Path (Join-Path $PublicDir "android-chrome-512x512.png")

$favicon = New-BrandBitmap -Mark $mark -Size 48 -Transparent $false
$icon = [System.Drawing.Icon]::FromHandle($favicon.GetHicon())
$stream = [System.IO.File]::Create((Join-Path $PublicDir "favicon.ico"))
$icon.Save($stream)
$stream.Dispose()
$icon.Dispose()
$favicon.Dispose()
$mark.Dispose()
$fontCollection.Dispose()
