#!/bin/bash
# 더블클릭으로 서버를 켜고 브라우저를 여는 WordPOP.app을 프로젝트 폴더에 만든다.
# 앱에는 이 프로젝트의 경로가 기록되므로, 프로젝트 폴더를 옮기면 다시 실행한다.
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
app="$project_dir/WordPOP.app"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

escaped_dir="${project_dir//\\/\\\\}"
escaped_dir="${escaped_dir//\"/\\\"}"

cat >"$work/WordPOP.applescript" <<APPLESCRIPT
property launcher : "${escaped_dir}/scripts/launcher.sh"
global serverPID, appURL

on run
	set serverPID to ""
	set appURL to ""
	try
		set output to do shell script "/bin/bash " & quoted form of launcher & " start"
	on error errorMessage
		display alert "WordPOP을 시작하지 못했습니다" message errorMessage as critical
		quit
		return
	end try
	set AppleScript's text item delimiters to " "
	set serverPID to text item 1 of output
	set appURL to text item 2 of output
	set AppleScript's text item delimiters to ""
	open location appURL
	-- 터미널 등에서 직접 켠 서버는 이 앱이 관리하지 않으므로 브라우저만 열고 끝낸다.
	if serverPID is "-" then
		set serverPID to ""
		quit
	end if
end run

on reopen
	if appURL is not "" then open location appURL
end reopen

on idle
	if serverPID is not "" then
		try
			do shell script "/bin/bash " & quoted form of launcher & " alive " & serverPID
		on error
			set serverPID to ""
			display alert "WordPOP 서버가 종료되었습니다" message "자세한 내용은 ~/Library/Logs/WordPOP/server.log를 확인해 주세요." as warning
			quit
		end try
	end if
	return 5
end idle

on quit
	if serverPID is not "" then
		try
			do shell script "/bin/bash " & quoted form of launcher & " stop " & serverPID
		end try
		set serverPID to ""
	end if
	continue quit
end quit
APPLESCRIPT

rm -rf "$app"
osacompile -s -o "$app" "$work/WordPOP.applescript"

plist="$app/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "local.wordpop.launcher" "$plist"
plutil -replace CFBundleName -string "WordPOP" "$plist"
plutil -remove CFBundleIconName "$plist" 2>/dev/null || true
rm -f "$app/Contents/Resources/Assets.car"

# favicon.svg에 여백을 두어 macOS 아이콘 크기에 맞추고, 모서리가 투명한 PNG로 그린다.
# 변환에 실패하면 기본 아이콘을 유지한다.
sed 's/viewBox="0 0 64 64"/viewBox="-7 -7 78 78" width="1024" height="1024"/' "$project_dir/public/favicon.svg" >"$work/icon.svg"
cat >"$work/render.js" <<'JXA'
ObjC.import('AppKit');
function run([input, output]) {
  const image = $.NSImage.alloc.initWithContentsOfFile(input);
  if (!image || image.isNil()) throw new Error('SVG를 읽지 못했습니다.');
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 1024, 1024, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 1024, 1024), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(output, true);
}
JXA
if osascript -l JavaScript "$work/render.js" "$work/icon.svg" "$work/icon.png" >/dev/null 2>&1 && [ -f "$work/icon.png" ]; then
  iconset="$work/WordPOP.iconset"
  mkdir "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$work/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$work/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/applet.icns"
else
  echo "아이콘 변환을 건너뜁니다."
fi

codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "로컬 서명에 실패했습니다. 처음 열 때 마우스 오른쪽 버튼 → 열기를 사용하세요."
touch "$app"
echo "만들었습니다: $app"
