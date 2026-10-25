#define AppName "Xovra"
#ifndef AppVersion
#define AppVersion "0.1.3"
#endif
#define AppPublisher "Xovra"
#define AppExeName "xovra.exe"
#define AppSourceDir "..\out\Xovra-win32-x64"
#define AppIcon "..\assets\xovra-icon.ico"
#define WizardArt "..\assets\xovra-wizard.bmp"
#define WizardSmallArt "..\assets\xovra-wizard-small.bmp"

[Setup]
AppId={{D92F0D39-7A1B-4AC3-90A2-87A543B68F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Xovra
DefaultGroupName=Xovra
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64
OutputDir=..\out\make\inno
OutputBaseFilename=Xovra-{#AppVersion}-Setup
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
WizardStyle=modern
WizardImageFile={#WizardArt}
WizardSmallImageFile={#WizardSmallArt}
WizardImageBackColor=$F8F7EE
WizardSmallImageBackColor=$F8F7EE
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#AppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Xovra"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\Xovra"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch Xovra"; Flags: nowait postinstall skipifsilent

[Messages]
WelcomeLabel1=Install Xovra
WelcomeLabel2=This wizard will install Xovra, your local media workspace, on this computer.
FinishedHeadingLabel=Xovra is ready
FinishedLabel=Setup has finished installing Xovra. Select Finish to open it.