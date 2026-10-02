; Bones Desktop Companion — Inno Setup installer script
; Wraps the electron-builder win-unpacked output into a proper Windows installer
; Run: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" bones.iss

#define AppName "Bones"
#define AppVersion "1.0.2"
#define AppPublisher "Bones Desktop"
#define AppExeName "Bones.exe"
#define SourceDir "D:\New folder (4)\dist\win-unpacked"
#define OutputDir "D:\New folder (4)\dist"

[Setup]
AppId={{A7B3C2D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir={#OutputDir}
OutputBaseFilename=Bones Setup 1.0.2
SetupIconFile=D:\New folder (4)\mascot\assets\buddy.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}";

[Files]
; Copy everything from the win-unpacked folder
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace
Source: "D:\New folder (4)\mascot\assets\buddy.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu shortcut
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\buddy.ico"
; Desktop shortcut (optional, user chooses)
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\buddy.ico"; Tasks: desktopicon
; Uninstaller in start menu
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"; IconFilename: "{app}\buddy.ico"

[Run]
; Launch Bones after install/update
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall

[UninstallDelete]
; Clean up settings only if user explicitly wants (we don't auto-delete AppData)
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  // Terminate any running Bones or bridge processes silently before copying files
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /t /im Bones.exe', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /t /im bridge.exe', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(1000);
  Result := True;
end;

function InitializeUninstall(): Boolean;
var
  ErrorCode: Integer;
begin
  // Force-kill Bones and bridge so no executables or DLLs remain locked
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /t /im Bones.exe', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /t /im bridge.exe', '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  Sleep(800);
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // Completely wipe the entire app directory and all runtime logs/caches
    DelTree(ExpandConstant('{app}'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\Bones'), True, True, True);
  end;
end;

