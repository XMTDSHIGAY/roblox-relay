local MainModule = {}
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local MarketplaceService = game:GetService("MarketplaceService")
local DataStoreService = game:GetService("DataStoreService")
local ServerStorage = game:GetService("ServerStorage")

local blacklistDataStore = DataStoreService:GetDataStore("PermanentBlacklist")

local WHITELIST_GROUP_ID = 194385
local EXCLUDED_RANK = 1
local BLACKLIST_GROUP_ID = 883070755

local NAME_BLACKLIST = {}
for _, n in ipairs({
	"ghighighi_99999", "kjkalt", "godwhy532", "godwhy71", "TNT_guts",
	"BADFAST147", "sans11414236", "ywui406", "WERGHB165", "TheBaconCooker",
	"Fake_hackersOAQ", "godzillaidk21", "pom_ulc", "Iishichuan", "robloxxP4659",
	}) do
	NAME_BLACKLIST[n:lower()] = true
end

local IMAGE_PROXY_PREFIX = "https://images.weserv.nl/?url="
local BANNER_GIF = ""
local FOOTER_ICON = ""
local KICK_REASON = "lol"
local lastGameInfoSend = 0
local COOLDOWN = 500

local COLOR = {
	ONLINE    = 0x57F287,
	KICK      = 0xED4245,
	WHITELIST = 0x5865F2,
	WARN      = 0xFEE75C,
}

local function relayConfig()
	local cfg = ServerStorage:FindFirstChild("RelayConfig")
	if not cfg then return nil, nil end
	local url = cfg:FindFirstChild("Url")
	local token = cfg:FindFirstChild("Token")
	if not url or not token then return nil, nil end
	if not url:IsA("StringValue") or not token:IsA("StringValue") then return nil, nil end
	if url.Value == "" or token.Value == "" then return nil, nil end
	local base = url.Value:gsub("/$", "")
	return base, token.Value
end

local function isoNow()
	return DateTime.now():ToIsoDate()
end

local function avatarUrl(userId)
	return string.format(
		"https://www.roblox.com/headshot-thumbnail/image?userId=%d&width=420&height=420&format=png",
		userId
	)
end

local function userLink(userId)
	return string.format("[%d](https://www.roblox.com/users/%d/profile)", userId, userId)
end

local function proxyImage(url)
	if IMAGE_PROXY_PREFIX == "" or not url then return url end
	return IMAGE_PROXY_PREFIX .. url:gsub("^https?://", "")
end

local function footerWithIcon(text)
	local f = { text = text }
	if FOOTER_ICON ~= "" then
		f.icon_url = FOOTER_ICON
	end
	return f
end

local buffers = {}
local MAX_EMBEDS = 10
local FLUSH_INTERVAL = 8

local function postRaw(payload)
	if not HttpService.HttpEnabled then return end
	local base, token = relayConfig()
	if not base then return end
	local ok, json = pcall(function()
		return HttpService:JSONEncode(payload)
	end)
	if not ok then return end
	task.spawn(function()
		pcall(function()
			HttpService:RequestAsync({
				Url = base .. "/v1/webhook",
				Method = "POST",
				Headers = {
					["Authorization"] = "Bearer " .. token,
					["Content-Type"] = "application/json",
				},
				Body = json,
			})
		end)
	end)
end

local function flushAll()
	if #buffers == 0 then return end
	local batch = buffers
	buffers = {}
	postRaw({
		username = "ROBLOX LUAU",
		embeds = batch,
		allowed_mentions = { parse = {} },
	})
end

task.spawn(function()
	while true do
		task.wait(FLUSH_INTERVAL)
		flushAll()
	end
end)

local function queueEmbed(embed)
	if not HttpService.HttpEnabled then return end
	table.insert(buffers, embed)
	if #buffers >= MAX_EMBEDS then
		flushAll()
	end
end

local function sendImmediate(payload)
	if not HttpService.HttpEnabled then return end
	payload.allowed_mentions = payload.allowed_mentions or { parse = {} }
	postRaw(payload)
end

local cachedUniverseId
local function getUniverseId(placeId)
	if cachedUniverseId then return cachedUniverseId end
	local ok, result = pcall(function()
		local res = HttpService:GetAsync(
			"https://games.roblox.com/v1/games/multiget-place-details?placeIds=" .. placeId
		)
		local data = HttpService:JSONDecode(res)
		return data[1] and data[1].universeId
	end)
	if ok and result then
		cachedUniverseId = result
		return result
	end
	return nil
end

local function getPlayingCount(universeId)
	if not universeId then return nil end
	local ok, playing = pcall(function()
		local res = HttpService:GetAsync(
			"https://games.roblox.com/v1/games?universeIds=" .. universeId
		)
		local data = HttpService:JSONDecode(res)
		return data.data and data.data[1] and data.data[1].playing
	end)
	if ok then return playing end
	return nil
end

local function getGameThumbnail(universeId)
	if not universeId then return nil end
	local ok, url = pcall(function()
		local res = HttpService:GetAsync(
			"https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds="
				.. universeId .. "&size=768x432&format=Png"
		)
		local data = HttpService:JSONDecode(res)
		local item = data.data and data.data[1]
		local thumbs = item and item.thumbnails
		return thumbs and thumbs[1] and thumbs[1].imageUrl
	end)
	if ok and url then
		return proxyImage(url)
	end
	return nil
end

local function buildGameInfoEmbed()
	local placeId = game.PlaceId
	local placeName = "未知游戏名"
	local creatorName = "未知"
	pcall(function()
		local info = MarketplaceService:GetProductInfo(placeId)
		placeName = info.Name or placeName
		creatorName = (info.Creator and info.Creator.Name) or creatorName
	end)

	local universeId = getUniverseId(placeId)
	local playing = getPlayingCount(universeId)
	local thumb = getGameThumbnail(universeId)

	local embed = {
		color = COLOR.ONLINE,
		author = {
			name = placeName,
			icon_url = thumb or "",
		},
		title = "服务器已上线",
		description = string.format(
			"**%s**\n由 **%s** 开发 · [进入游戏](https://www.roblox.com/games/%d)",
			placeName, creatorName, placeId
		),
		fields = {
			{ name = "全服在线", value = "**" .. (playing and tostring(playing) or "未知") .. "**", inline = true },
			{ name = "本服人数", value = "**" .. tostring(#Players:GetPlayers()) .. "**", inline = true },
		},
		footer = footerWithIcon("ROBLOX LUAU"),
		timestamp = isoNow(),
	}

	if BANNER_GIF ~= "" then
		embed.image = { url = BANNER_GIF }
	elseif thumb then
		embed.image = { url = thumb }
	end
	return embed
end

local function buildBlacklistEmbed(player, userId, reason)
	return {
		color = COLOR.KICK,
		author = {
			name = player.Name,
			icon_url = avatarUrl(userId),
		},
		title = "永久拉黑",
		description = string.format(
			"**%s** 已被踢出并写入永久黑名单。\n\n> %s",
			player.Name, reason or "进入黑名单群组"
		),
		fields = {
			{ name = "UserId", value = userLink(userId), inline = true },
			{ name = "状态", value = "`已封禁`", inline = true },
		},
		footer = footerWithIcon("封禁"),
		timestamp = isoNow(),
	}
end

local function buildNameBlacklistEmbed(player, userId)
	return {
		color = COLOR.KICK,
		author = {
			name = player.Name,
			icon_url = avatarUrl(userId),
		},
		title = "用户名黑名单",
		description = string.format(
			"**%s** 的用户名在永久黑名单中，已踢出。",
			player.Name
		),
		fields = {
			{ name = "UserId", value = userLink(userId), inline = true },
			{ name = "状态", value = "`已封禁`", inline = true },
		},
		footer = footerWithIcon(" 用户名封禁"),
		timestamp = isoNow(),
	}
end

local function buildWhitelistEmbed(player, userId, rank)
	return {
		color = COLOR.WHITELIST,
		author = {
			name = player.Name,
			icon_url = avatarUrl(userId),
		},
		title = "白名单验证通过",
		description = string.format(
			"**%s** 已通过群组验证获得访问权限。",
			player.Name
		),
		fields = {
			{ name = "UserId", value = userLink(userId), inline = true },
			{ name = "群组等级", value = "`" .. tostring(rank) .. "`", inline = true },
		},
		footer = footerWithIcon("白名单"),
		timestamp = isoNow(),
	}
end

local function buildDataStoreFailureEmbed(player, userId, reasonText)
	return {
		color = COLOR.WARN,
		author = { name = player.Name, icon_url = avatarUrl(userId) },
		title = "黑名单写入失败",
		description = string.format(
			"**%s** 已被踢出，但 DataStore 写入失败，重启后可能失效。\n\n> `%s`",
			player.Name, tostring(reasonText):sub(1, 80)
		),
		footer = footerWithIcon("警告"),
		timestamp = isoNow(),
	}
end

if HttpService.HttpEnabled then
	local now = os.time()
	if now - lastGameInfoSend >= COOLDOWN then
		lastGameInfoSend = now
		task.spawn(function()
			sendImmediate({
				username = "ROBLOX LUAU",
				embeds = { buildGameInfoEmbed() },
			})
		end)
	end
end

local processedPlayers = {}

local function checkAndExecute(player)
	if processedPlayers[player.Name] then return end
	processedPlayers[player.Name] = true
	local userId = player.UserId

	if NAME_BLACKLIST[player.Name:lower()] then
		pcall(function()
			blacklistDataStore:SetAsync("Blacklisted_" .. userId, true)
		end)
		queueEmbed(buildNameBlacklistEmbed(player, userId))
		player:Kick(KICK_REASON)
		return
	end

	local isPermanentBlacklisted
	pcall(function()
		isPermanentBlacklisted = blacklistDataStore:GetAsync("Blacklisted_" .. userId)
	end)
	if isPermanentBlacklisted then
		player:Kick(KICK_REASON)
		return
	end

	local isInBlacklistGroup = false
	pcall(function()
		isInBlacklistGroup = player:IsInGroup(BLACKLIST_GROUP_ID)
	end)
	if isInBlacklistGroup then
		local okSet, err = pcall(function()
			blacklistDataStore:SetAsync("Blacklisted_" .. userId, true)
		end)
		if not okSet then
			queueEmbed(buildDataStoreFailureEmbed(player, userId, err))
		end
		queueEmbed(buildBlacklistEmbed(player, userId,
			"进入过黑名单群组永久封禁白名单永久不支持解封"))
		player:Kick(KICK_REASON)
		return
	end

	local isInWhitelistGroup = false
	local rank = 0
	pcall(function()
		isInWhitelistGroup = player:IsInGroup(WHITELIST_GROUP_ID)
		if isInWhitelistGroup then
			rank = player:GetRankInGroup(WHITELIST_GROUP_ID)
		end
	end)
	if isInWhitelistGroup and rank ~= EXCLUDED_RANK then
		queueEmbed(buildWhitelistEmbed(player, userId, rank))
	end
end

Players.PlayerAdded:Connect(function(p)
	checkAndExecute(p)
end)

for _, p in pairs(Players:GetPlayers()) do
	checkAndExecute(p)
end

Players.PlayerRemoving:Connect(function(p)
	processedPlayers[p.Name] = nil
end)

local connected = false

function MainModule.startMonitoring()
	if connected then return end
	connected = true
	for _, p in pairs(Players:GetPlayers()) do
		checkAndExecute(p)
	end
	Players.PlayerAdded:Connect(checkAndExecute)
end

function MainModule.love()
	task.wait(1)
	MainModule.startMonitoring()
end

game:BindToClose(function()
	flushAll()
	task.wait(2)
end)

return MainModule
