package com.xovra.mobile

import android.content.ContentValues
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.caverock.androidsvg.SVG
import com.chaquo.python.android.AndroidPlatform
import com.chaquo.python.Python
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.File
import java.util.Locale

private data class Palette(
    val background: Color, val surface: Color, val inset: Color, val ink: Color,
    val muted: Color, val muted2: Color, val lime: Color, val limeInk: Color,
    val line: Color, val clayShadow: Color
)

private val LightPalette = Palette(
    Color(0xFFF0EEE4), Color(0xFFFAF9F2), Color(0xFFF4F3EB), Color(0xFF272C24),
    Color(0xFF62685B), Color(0xFF7B8172), Color(0xFFC8ED68), Color(0xFF28331B),
    Color(0xFFDEDFCE), Color(0xFFAEB49A)
)
private val DarkPalette = Palette(
    Color(0xFF141711), Color(0xFF20241D), Color(0xFF191D17), Color(0xFFF2F2E9),
    Color(0xFFC0C5B5), Color(0xFFA6AD98), Color(0xFFC8ED68), Color(0xFF28331B),
    Color(0xFF3D4435), Color(0xFF080A07)
)

private val sourceOptions = listOf(
    "auto" to "Auto", "youtube" to "YouTube", "tiktok" to "TikTok", "instagram" to "Instagram",
    "x" to "X", "facebook" to "Facebook", "dailymotion" to "Dailymotion", "more" to "More"
)

private data class MediaFormat(
    val id: String,
    val label: String,
    val ext: String,
    val audioOnly: Boolean,
    val size: Long?
)

private data class MediaItem(val title: String, val source: String, val formats: List<MediaFormat>)
private data class ReleaseCheck(val updateAvailable: Boolean, val currentVersion: String, val latestVersion: String, val releaseUrl: String)

class MainActivity : ComponentActivity() {
    private val history = mutableStateListOf<String>()
    private val downloads = mutableStateListOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Python.isStarted()) Python.start(AndroidPlatform(this))
        val shared = if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        } else ""
        val preferences = getSharedPreferences("xovra-mobile", Context.MODE_PRIVATE)
        setContent {
            var darkMode by remember { mutableStateOf(preferences.getBoolean("dark", false)) }
            val palette = if (darkMode) DarkPalette else LightPalette
            SideEffect {
                window.statusBarColor = if (darkMode) android.graphics.Color.rgb(21, 24, 18) else android.graphics.Color.rgb(242, 241, 231)
                window.navigationBarColor = if (darkMode) android.graphics.Color.rgb(21, 24, 18) else android.graphics.Color.rgb(242, 241, 231)
                window.decorView.systemUiVisibility = if (darkMode) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
            val scheme = if (darkMode) darkColorScheme(
                primary = palette.lime, onPrimary = palette.limeInk, background = palette.background,
                surface = palette.surface, onBackground = palette.ink, onSurface = palette.ink, outline = palette.line
            ) else lightColorScheme(
                primary = palette.lime, onPrimary = palette.limeInk, background = palette.background,
                surface = palette.surface, onBackground = palette.ink, onSurface = palette.ink, outline = palette.line
            )
            MaterialTheme(colorScheme = scheme) {
                XovraScreen(
                    initialLink = shared, history = history, downloads = downloads, palette = palette,
                    darkMode = darkMode,
                    onToggleTheme = {
                        darkMode = !darkMode
                        preferences.edit().putBoolean("dark", darkMode).apply()
                    },
                    onAnalyze = { url, done -> analyze(url, done) },
                    onDownload = { url, format, done -> download(url, format, done) },
                    onCheckForUpdates = { done -> checkForAppUpdate(done) },
                    onOpenRelease = { url -> openReleasePage(url) }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    private fun analyze(url: String, done: (Result<MediaItem>) -> Unit) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val raw = Python.getInstance().getModule("xovra_mobile").callAttr("analyze", url).toString()
                    val json = JSONObject(raw)
                    val formatsJson = json.getJSONArray("formats")
                    val formats = (0 until formatsJson.length()).map { index ->
                        val row = formatsJson.getJSONObject(index)
                        MediaFormat(row.getString("id"), row.getString("label"), row.optString("ext", "mp4"), row.optBoolean("audioOnly"), if (row.has("size") && !row.isNull("size")) row.getLong("size") else null)
                    }
                    if (formats.isEmpty()) error("This link didn’t return a single-file MP4/WebM format. Try a different source or quality.")
                    MediaItem(json.optString("title", "Untitled media"), json.optString("source", "Media source"), formats)
                }
            }
            done(result)
        }
    }

    private fun checkForAppUpdate(done: (Result<ReleaseCheck>) -> Unit) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val connection = URL("https://api.github.com/repos/Diaxo1/Xovra-video-downloader-/releases?per_page=100").openConnection() as HttpURLConnection
                    connection.connectTimeout = 8000; connection.readTimeout = 8000
                    connection.setRequestProperty("Accept", "application/vnd.github+json")
                    connection.setRequestProperty("User-Agent", "Xovra-Android")
                    check(connection.responseCode == 200) { "GitHub could not be reached. Try again later." }
                    val releases = JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
                    connection.disconnect()
                    val release = (0 until releases.length()).map { releases.getJSONObject(it) }
                        .firstOrNull { it.optString("tag_name").startsWith("android-v") && !it.optBoolean("draft") && !it.optBoolean("prerelease") }
                        ?: error("No stable Android release was found.")
                    val latest = release.getString("tag_name").removePrefix("android-v")
                    val current = packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
                    val latestParts = latest.split(".").map { it.toIntOrNull() ?: 0 }
                    val currentParts = current.split(".").map { it.toIntOrNull() ?: 0 }
                    val newer = (0..2).firstNotNullOfOrNull { index ->
                        if ((latestParts.getOrElse(index) { 0 }) != (currentParts.getOrElse(index) { 0 })) latestParts.getOrElse(index) { 0 } > currentParts.getOrElse(index) { 0 } else null
                    } ?: false
                    ReleaseCheck(newer, current, latest, release.optString("html_url", "https://github.com/Diaxo1/Xovra-video-downloader-/releases"))
                }
            }
            done(result)
        }
    }

    private fun openReleasePage(url: String) {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun download(url: String, format: MediaFormat, done: (Result<String>) -> Unit) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val work = File(cacheDir, "xovra-downloads")
                    val raw = Python.getInstance().getModule("xovra_mobile")
                        .callAttr("download", url, format.id, work.absolutePath).toString()
                    val response = JSONObject(raw)
                    val sourceFile = File(response.getString("path"))
                    check(sourceFile.isFile) { "The downloaded file could not be found." }
                    val name = sourceFile.name.replace(Regex("[^A-Za-z0-9._ ()-]"), "_").take(140).ifBlank { "Xovra.${format.ext}" }
                    val mime = when (format.ext.lowercase(Locale.ROOT)) {
                        "mp4", "m4v" -> "video/mp4"
                        "webm" -> "video/webm"
                        "m4a" -> "audio/mp4"
                        "mp3" -> "audio/mpeg"
                        "opus" -> "audio/ogg"
                        else -> "application/octet-stream"
                    }
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Xovra")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: error("Android couldn’t create the Downloads file.")
                    try {
                        contentResolver.openOutputStream(uri)?.use { output -> sourceFile.inputStream().use { it.copyTo(output) } }
                            ?: error("Android couldn’t open the Downloads file.")
                        contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                        sourceFile.delete()
                        "Saved to Downloads/Xovra/$name"
                    } catch (error: Throwable) {
                        contentResolver.delete(uri, null, null)
                        throw error
                    }
                }
            }
            done(result)
        }
    }
}

@Composable
private fun XovraScreen(
    initialLink: String,
    history: MutableList<String>,
    downloads: MutableList<String>,
    palette: Palette,
    darkMode: Boolean,
    onToggleTheme: () -> Unit,
    onAnalyze: (String, (Result<MediaItem>) -> Unit) -> Unit,
    onDownload: (String, MediaFormat, (Result<String>) -> Unit) -> Unit,
    onCheckForUpdates: ((Result<ReleaseCheck>) -> Unit) -> Unit,
    onOpenRelease: (String) -> Unit
) {
    var url by remember { mutableStateOf(initialLink) }
    var loading by remember { mutableStateOf(false) }
    var downloading by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var savedMessage by remember { mutableStateOf<String?>(null) }
    var media by remember { mutableStateOf<MediaItem?>(null) }
    var selectedFormat by remember { mutableStateOf<String?>(null) }
    var selectedSource by remember { mutableStateOf("auto") }
    var manualSource by remember { mutableStateOf(false) }
    var activePage by remember { mutableStateOf("Analyzer") }
    var checkingUpdates by remember { mutableStateOf(false) }
    var updateMessage by remember { mutableStateOf<String?>(null) }
    var updateReleaseUrl by remember { mutableStateOf<String?>(null) }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = palette.background,
        bottomBar = {
            Row(
                Modifier.fillMaxWidth().background(palette.surface).padding(horizontal = 12.dp, vertical = 8.dp).navigationBarsPadding(),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                listOf("Analyzer", "Downloads", "Media tools", "History", "Settings").forEach { page ->
                    val chosen = activePage == page
                    val icon = when (page) { "Analyzer" -> "scan-line-nav"; "Downloads" -> "download"; "Media tools" -> "shapes"; "History" -> "history"; else -> "settings-2" }
                    Column(
                        Modifier.weight(1f).height(58.dp)
                            .then(if (chosen) Modifier.clip(RoundedCornerShape(12.dp)).background(palette.lime.copy(alpha = if (darkMode) .18f else .32f)).border(1.dp, palette.lime.copy(alpha = .4f), RoundedCornerShape(12.dp)) else Modifier)
                            .clickable(role = Role.Tab) { activePage = page },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        FigmaIcon(icon, Modifier.size(20.dp))
                        Spacer(Modifier.height(3.dp))
                        Text(if (page == "Media tools") "Tools" else page, color = if (chosen) palette.ink else palette.muted, fontSize = 11.sp, fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
                    }
                }
            }
        }
    ) { insets ->
        Column(Modifier.fillMaxSize().padding(insets)) {
            AppHeader(palette, onToggleTheme, onSettings = { activePage = "Settings" }, onHome = { activePage = "Analyzer" })
            when (activePage) {
                "Analyzer" -> AnalyzerPage(
                    palette = palette, url = url,
                    onUrlChange = { value ->
                        url = value; message = null; savedMessage = null
                        if (!manualSource) selectedSource = sourceFromUrl(value) ?: "auto"
                    },
                    selectedSource = selectedSource,
                    onSourceSelect = { source -> selectedSource = source; manualSource = source != "auto" },
                    history = history, media = media, selectedFormat = selectedFormat,
                    onFormatSelect = { selectedFormat = it },
                    loading = loading, downloading = downloading, message = message, savedMessage = savedMessage,
                    onAnalyze = {
                        if (url.isBlank()) { message = "Paste a link first."; return@AnalyzerPage }
                        loading = true; message = null; savedMessage = null; media = null
                        onAnalyze(url.trim()) { result ->
                            loading = false
                            result.onSuccess {
                                media = it; selectedFormat = it.formats.firstOrNull()?.id
                                if (url !in history) history.add(0, url)
                                while (history.size > 12) history.removeAt(history.lastIndex)
                            }.onFailure { message = it.message ?: "Couldn’t read this link." }
                        }
                    },
                    onDownload = {
                        val item = media ?: return@AnalyzerPage
                        val format = item.formats.firstOrNull { it.id == selectedFormat } ?: item.formats.first()
                        downloading = true; message = null; savedMessage = null
                        onDownload(url.trim(), format) { result ->
                            downloading = false
                            result.onSuccess {
                                savedMessage = it; downloads.add(0, it)
                                while (downloads.size > 20) downloads.removeAt(downloads.lastIndex)
                            }.onFailure { message = it.message ?: "Download failed." }
                        }
                    },
                    onClearHistory = { history.clear() },
                    onUseLink = { link -> url = link; selectedSource = sourceFromUrl(link) ?: "auto"; manualSource = false; activePage = "Analyzer" }
                )
                "Downloads" -> SimpleListPage("Downloads", "Files save to Downloads/Xovra on this phone.", downloads, palette, "Your saved files will appear here.")
                "History" -> HistoryPage(history, palette, { history.clear() }) { link -> url = link; activePage = "Analyzer" }
                "Media tools" -> ToolsPage(palette)
                else -> SettingsPage(palette, darkMode, onToggleTheme, checkingUpdates, updateMessage, updateReleaseUrl,
                    onCheck = {
                        checkingUpdates = true; updateMessage = null; updateReleaseUrl = null
                        onCheckForUpdates { result ->
                            checkingUpdates = false
                            result.onSuccess { check ->
                                updateMessage = if (check.updateAvailable) "Version " + check.latestVersion + " is ready to install." else "You are up to date · v" + check.currentVersion + "."
                                if (check.updateAvailable) updateReleaseUrl = check.releaseUrl
                            }.onFailure { updateMessage = it.message ?: "Could not check right now. Try again later." }
                        }
                    }, onOpenRelease = onOpenRelease)
            }
        }
    }
}

@Composable
private fun AppHeader(palette: Palette, onToggleTheme: () -> Unit, onSettings: () -> Unit, onHome: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(65.dp).padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Row(Modifier.clickable(onClick = onHome), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            Box(Modifier.size(36.dp).clay(palette.lime, RoundedCornerShape(14.dp), palette, 6.dp), contentAlignment = Alignment.Center) { FigmaIcon("scan-line", Modifier.size(23.dp)) }
            Text("xovra.", color = palette.ink, fontSize = 23.sp, fontWeight = FontWeight.Bold, letterSpacing = (-.8).sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            HeaderAction("moon", "Switch theme", palette, onToggleTheme)
            HeaderAction("settings-2", "Settings", palette, onSettings)
        }
    }
}

@Composable
private fun HeaderAction(icon: String, label: String, palette: Palette, onClick: () -> Unit) {
    Box(Modifier.size(42.dp).clay(palette.surface, RoundedCornerShape(15.dp), palette, 8.dp).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) {
        FigmaIcon(icon, Modifier.size(18.dp))
    }
}

@Composable
private fun AnalyzerPage(
    palette: Palette, url: String, onUrlChange: (String) -> Unit, selectedSource: String, onSourceSelect: (String) -> Unit,
    history: List<String>, media: MediaItem?, selectedFormat: String?, onFormatSelect: (String) -> Unit, loading: Boolean, downloading: Boolean,
    message: String?, savedMessage: String?, onAnalyze: () -> Unit, onDownload: () -> Unit,
    onClearHistory: () -> Unit, onUseLink: (String) -> Unit
) {
    val currentMedia = media
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 27.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
        item {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("THE MEDIA DESK", color = palette.muted, fontSize = 12.sp, letterSpacing = .4.sp)
                Column {
                    Text("Your media.", color = palette.ink, fontSize = 44.sp, lineHeight = 47.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1.7).sp)
                    Text("Your call.", color = palette.muted, fontSize = 44.sp, lineHeight = 47.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1.7).sp)
                }
                Text("Bring a link. Choose the version that fits.", color = palette.muted, fontSize = 14.sp, lineHeight = 20.sp)
            }
        }
        item { AnalyzerSteps(palette, hasLink = url.isNotBlank(), hasMedia = currentMedia != null) }
        item {
            Column(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(28.dp), palette, 11.dp).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(38.dp).clip(RoundedCornerShape(13.dp)).background(palette.lime), contentAlignment = Alignment.Center) {
                        Text("01", color = palette.limeInk, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("START WITH A LINK", color = palette.muted, fontSize = 11.sp, letterSpacing = .65.sp, fontWeight = FontWeight.SemiBold)
                        Text("Choose a source", color = palette.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(15.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            FigmaIcon("sparkles", Modifier.size(13.dp))
                            Text("Auto detects from your link", color = palette.muted, fontSize = 13.sp)
                        }
                    }
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 1.dp)) {
                        items(sourceOptions) { (key, label) ->
                            SourceChip(key, label, key == selectedSource, palette, Modifier) { onSourceSelect(key) }
                        }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Paste a video or audio link", color = palette.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    val context = LocalContext.current
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = url, onValueChange = onUrlChange,
                        modifier = Modifier.weight(1f).height(60.dp), singleLine = true,
                        placeholder = { Text("https://", color = palette.muted2, fontSize = 14.sp) },
                        leadingIcon = { FigmaIcon("link", Modifier.size(20.dp)) },
                        trailingIcon = {
                            Box(Modifier.size(44.dp).clickable(role = Role.Button) { readClipboard(context)?.let(onUrlChange) }, contentAlignment = Alignment.Center) {
                                FigmaIcon("clipboard", Modifier.size(19.dp))
                            }
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        shape = RoundedCornerShape(16.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = palette.inset, unfocusedContainerColor = palette.inset,
                            focusedBorderColor = palette.muted, unfocusedBorderColor = palette.line,
                            focusedTextColor = palette.ink, unfocusedTextColor = palette.ink,
                            cursorColor = palette.limeInk, focusedLeadingIconColor = palette.muted,
                            unfocusedLeadingIconColor = palette.muted, focusedTrailingIconColor = palette.muted,
                            unfocusedTrailingIconColor = palette.muted
                        )
                    )
                    Button(
                        onClick = onAnalyze, enabled = !loading && !downloading,
                        modifier = Modifier.height(60.dp).widthIn(min = 126.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = palette.lime, contentColor = palette.limeInk),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp)
                    ) {
                        if (loading) CircularProgressIndicator(Modifier.size(18.dp), color = palette.limeInk, strokeWidth = 2.dp)
                        else { Text("Analyze link", fontSize = 13.sp, fontWeight = FontWeight.SemiBold); Spacer(Modifier.width(7.dp)); FigmaIcon("arrow-right", Modifier.size(16.dp)) }
                    }
                    }
                    Text("Paste a supported link. Xovra reads its available formats.", color = palette.muted, fontSize = 13.sp, lineHeight = 18.sp)
                    message?.let { Text(it, color = Color(0xFFB84D3E), fontSize = 13.sp) }
                    savedMessage?.let { Text(it, color = palette.limeInk, fontSize = 13.sp) }
                }
                Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(palette.line))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FigmaIcon("shield-check", Modifier.size(16.dp))
                        Text("Only download media you have permission to use.", color = palette.muted, fontSize = 12.sp, lineHeight = 17.sp)
                    }
                }
            }
        }
        if (currentMedia != null) item { FormatsSection(currentMedia, selectedFormat, palette, downloading, onFormatSelect, onDownload) }
        item { RecentSection(history, media, palette, onClearHistory, onUseLink) }
        item { WorkspaceDetails(palette) }
    }
}

@Composable
private fun AnalyzerSteps(palette: Palette, hasLink: Boolean, hasMedia: Boolean) {
    val activeStep = if (hasMedia) 2 else if (hasLink) 1 else 0
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(palette.surface)
            .border(1.dp, palette.line, RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        listOf("Paste link", "Pick format", "Save file").forEachIndexed { index, label ->
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(
                    Modifier.size(25.dp).clip(RoundedCornerShape(9.dp))
                        .background(if (index <= activeStep) palette.lime else palette.inset),
                    contentAlignment = Alignment.Center
                ) { Text("0${index + 1}", color = if (index <= activeStep) palette.limeInk else palette.muted, fontSize = 10.sp, fontWeight = FontWeight.Bold) }
                Text(label, color = if (index <= activeStep) palette.ink else palette.muted, fontSize = 11.sp, fontWeight = if (index == activeStep) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (index < 2) Text("·", color = palette.muted2, fontSize = 16.sp)
        }
    }
}

@Composable
private fun SourceChip(key: String, label: String, selected: Boolean, palette: Palette, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.then(modifier).height(42.dp).clip(shape).background(if (selected) palette.lime else palette.surface)
        .border(1.dp, if (selected) palette.lime.copy(alpha = .75f) else palette.line, shape)
        .clickable(role = Role.RadioButton, onClick = onClick).padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        when (key) { "x" -> Text("X", color = palette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold); "more" -> FigmaIcon("ellipsis", Modifier.size(17.dp)); else -> FigmaIcon(sourceIcon(key), Modifier.size(17.dp)) }
        Text(label, color = if (selected) palette.limeInk else palette.ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Clip)
    }
}

private fun sourceIcon(key: String) = when (key) {
    "auto" -> "sparkles"; "youtube" -> "youtube"; "tiktok" -> "music-2"; "instagram" -> "instagram"
    "facebook" -> "facebook"; "dailymotion" -> "youtube-source"; else -> "ellipsis"
}

@Composable
private fun PrimaryAction(label: String, loading: Boolean, palette: Palette, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(54.dp).clay(palette.lime, RoundedCornerShape(16.dp), palette, 7.dp)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        if (loading) CircularProgressIndicator(Modifier.size(19.dp), color = palette.limeInk, strokeWidth = 2.dp)
        else { Text(label, color = palette.limeInk, fontSize = 14.sp, fontWeight = FontWeight.SemiBold); Spacer(Modifier.width(10.dp)); FigmaIcon("arrow-right", Modifier.size(18.dp)) }
    }
}

@Composable
private fun FormatsSection(media: MediaItem, selected: String?, palette: Palette, downloading: Boolean, onSelect: (String) -> Unit, onDownload: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Available formats", color = palette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Column(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(22.dp), palette, 9.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(media.title, color = palette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(media.source, color = palette.muted, fontSize = 12.sp)
            media.formats.take(8).forEach { format ->
                Row(Modifier.fillMaxWidth().clay(if (selected == format.id) palette.lime.copy(alpha = .24f) else palette.inset, RoundedCornerShape(12.dp), palette, 3.dp)
                    .clickable(role = Role.RadioButton) { onSelect(format.id) }.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(format.label, color = palette.ink, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    format.size?.let { Text(formatBytes(it), color = palette.muted, fontSize = 11.sp) }
                }
            }
            Text("${media.formats.size} formats returned by the source.", color = palette.muted, fontSize = 12.sp)
            PrimaryAction("Download", downloading, palette, !downloading, onDownload)
        }
    }
}

@Composable
private fun RecentSection(history: List<String>, media: MediaItem?, palette: Palette, onClear: () -> Unit, onUseLink: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Recent links", color = palette.ink, fontSize = 16.sp, fontWeight = FontWeight.Medium)
            if (history.isNotEmpty()) Text("Clear", color = palette.muted, fontSize = 12.sp, modifier = Modifier.clickable(role = Role.Button, onClick = onClear).padding(6.dp))
        }
        if (history.isEmpty()) Text("Links you check will appear here.", color = palette.muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 10.dp))
        history.take(5).forEach { link ->
            val host = runCatching { android.net.Uri.parse(link).host?.removePrefix("www.") }.getOrNull() ?: "Media link"
            val title = if (media != null && history.firstOrNull() == link) media.title else host
            Row(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(20.dp), palette, 8.dp).padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(38.dp).clay(palette.surface, RoundedCornerShape(13.dp), palette, 5.dp), contentAlignment = Alignment.Center) { FigmaIcon(if (host.contains("youtu", true)) "youtube-source" else "link", Modifier.size(22.dp)) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(title, color = palette.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(link, color = palette.muted, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(host, color = palette.muted, fontSize = 10.sp); FigmaIcon("separator", Modifier.size(3.dp)); Text(if (history.firstOrNull() == link) "Just now" else "Recent", color = palette.muted, fontSize = 10.sp)
                    }
                }
                Column(Modifier.clay(palette.inset, RoundedCornerShape(12.dp), palette, 3.dp).clickable(role = Role.Button) { onUseLink(link) }.padding(horizontal = 10.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Use link", color = palette.ink, fontSize = 10.sp); FigmaIcon("arrow-up-right", Modifier.size(13.dp))
                }
            }
        }
    }
}

@Composable
private fun WorkspaceDetails(palette: Palette) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(20.dp), palette, 8.dp).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(36.dp).clay(palette.inset, RoundedCornerShape(12.dp), palette, 4.dp), contentAlignment = Alignment.Center) { FigmaIcon("user-round", Modifier.size(18.dp)) }
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) { Text("Guest workspace", color = palette.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold); Text("Local session", color = palette.muted, fontSize = 11.sp) }
            FigmaIcon("chevrons-up-down", Modifier.size(15.dp))
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            FigmaIcon("status-indicator", Modifier.size(5.dp)); Spacer(Modifier.width(7.dp)); Text("Local engine ready", color = palette.muted, fontSize = 10.sp)
        }
    }
}

@Composable
private fun SimpleListPage(title: String, subtitle: String, rows: List<String>, palette: Palette, emptyText: String) {
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp).padding(top = 28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { Text(title, color = palette.ink, fontSize = 34.sp, fontWeight = FontWeight.Bold); Text(subtitle, color = palette.muted, fontSize = 14.sp) }
        if (rows.isEmpty()) Text(emptyText, color = palette.muted, fontSize = 14.sp)
        rows.forEach { Text(it, color = palette.ink, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(16.dp), palette, 6.dp).padding(16.dp)) }
    }
}

@Composable
private fun HistoryPage(history: List<String>, palette: Palette, onClear: () -> Unit, onUseLink: (String) -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp).padding(top = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { Text("History", color = palette.ink, fontSize = 34.sp, fontWeight = FontWeight.Bold); Text("Links stay in this local session.", color = palette.muted, fontSize = 14.sp) }
            if (history.isNotEmpty()) Text("Clear", color = palette.muted, fontSize = 12.sp, modifier = Modifier.clickable(role = Role.Button, onClick = onClear).padding(8.dp))
        }
        if (history.isEmpty()) Text("Links you check will appear here.", color = palette.muted, fontSize = 14.sp)
        history.forEach { link -> Text(link, color = palette.ink, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(16.dp), palette, 6.dp).clickable(role = Role.Button) { onUseLink(link) }.padding(14.dp)) }
    }
}

@Composable
private fun ToolsPage(palette: Palette) {
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp).padding(top = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { Text("Media tools", color = palette.ink, fontSize = 34.sp, fontWeight = FontWeight.Bold); Text("Clip, compress, convert or extract audio.", color = palette.muted, fontSize = 14.sp) }
        listOf("Clip video" to "Cut a section", "Compress" to "Shrink file size", "Convert" to "Change video format", "Extract audio" to "Save the soundtrack", "Make GIF" to "Create a short looping clip").forEach { (title, copy) ->
            Row(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(18.dp), palette, 7.dp).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(title, color = palette.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold); Text(copy, color = palette.muted, fontSize = 12.sp) }
                Text("Desktop app", color = palette.muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun SettingsPage(
    palette: Palette, darkMode: Boolean, onToggleTheme: () -> Unit, checkingUpdates: Boolean,
    updateMessage: String?, updateReleaseUrl: String?, onCheck: () -> Unit, onOpenRelease: (String) -> Unit
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(top = 26.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) { Text("Settings", color = palette.ink, fontSize = 34.sp, fontWeight = FontWeight.Bold); Text("Your appearance, updates and local data.", color = palette.muted, fontSize = 14.sp) }
        Row(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(18.dp), palette, 4.dp).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text("Dark theme", color = palette.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold); Text("Keep the lime accent in both themes.", color = palette.muted, fontSize = 13.sp) }
            Switch(checked = darkMode, onCheckedChange = { onToggleTheme() })
        }
        Column(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(18.dp), palette, 4.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("App updates", color = palette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("Xovra for Android · v" + BuildConfig.VERSION_NAME, color = palette.muted, fontSize = 13.sp)
            Button(onClick = onCheck, enabled = !checkingUpdates, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = palette.lime, contentColor = palette.limeInk)) {
                if (checkingUpdates) CircularProgressIndicator(Modifier.size(17.dp), color = palette.limeInk, strokeWidth = 2.dp) else Text("Check for updates", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            }
            updateMessage?.let { Text(it, color = palette.muted, fontSize = 14.sp, lineHeight = 20.sp) }
            updateReleaseUrl?.let {
                Row(Modifier.clickable(role = Role.Button) { onOpenRelease(it) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text("Open Android release", color = palette.limeInk, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    FigmaIcon("arrow-up-right", Modifier.size(16.dp))
                }
            }
        }
        Column(Modifier.fillMaxWidth().clay(palette.surface, RoundedCornerShape(18.dp), palette, 4.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text("Release notes · v0.1.3", color = palette.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("• A guided link → format → save flow, with a more sculpted analyzer surface.", color = palette.muted, fontSize = 13.sp, lineHeight = 19.sp)
            Text("• Updated cream and lime colors with a clearer dark theme.", color = palette.muted, fontSize = 13.sp, lineHeight = 19.sp)
            Text("• Downloads remain local and Xovra stays free with no ads.", color = palette.muted, fontSize = 13.sp, lineHeight = 19.sp)
        }
        Text("Downloads are saved to Downloads/Xovra on this device.", color = palette.muted, fontSize = 13.sp, lineHeight = 20.sp)
    }
}

@Composable
private fun FigmaIcon(name: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val svg = remember(name) { runCatching { SVG.getFromAsset(context.assets, "design/$name.svg") }.getOrNull() }
    if (svg != null) Canvas(modifier) { drawIntoCanvas { canvas -> svg.renderToCanvas(canvas.nativeCanvas, RectF(0f, 0f, size.width, size.height)) } }
}

private fun Modifier.clay(color: Color, shape: RoundedCornerShape, palette: Palette, elevation: Dp): Modifier =
    shadow(elevation, shape, clip = false, ambientColor = palette.clayShadow.copy(alpha = if (palette == DarkPalette) .26f else .34f), spotColor = palette.clayShadow.copy(alpha = if (palette == DarkPalette) .4f else .22f))
        .clip(shape).background(color, shape).border(1.dp, palette.line.copy(alpha = .75f), shape)

private fun readClipboard(context: Context): String? {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    return clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
}

private fun sourceFromUrl(raw: String): String? {
    val host = runCatching { android.net.Uri.parse(raw).host?.lowercase(Locale.ROOT)?.removePrefix("www.") }.getOrNull() ?: return null
    return when {
        host == "youtu.be" || host.endsWith("youtube.com") -> "youtube"
        host.endsWith("tiktok.com") -> "tiktok"
        host.endsWith("instagram.com") -> "instagram"
        host == "x.com" || host.endsWith("twitter.com") -> "x"
        host == "facebook.com" || host == "fb.watch" || host.endsWith("facebook.com") -> "facebook"
        host.endsWith("dailymotion.com") -> "dailymotion"
        else -> null
    }
}
private fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "Size unknown"
    val mb = bytes / 1024.0 / 1024.0
    return if (mb >= 1000) String.format(Locale.ROOT, "%.1f GB", mb / 1024) else String.format(Locale.ROOT, "%.1f MB", mb)
}

