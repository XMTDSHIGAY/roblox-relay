local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local MarketplaceService = game:GetService("MarketplaceService")
local ServerStorage = game:GetService("ServerStorage")

local GameData = {
	PlaceId = 0,
	GameName = "",
	PlayerCount = 0,
	GameIcon = "",
	GameLink = "",
	ServerName = "",
	ServerIcon = ""
}

local uploadedPlaceIds = {}

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

local function updateGameInfo()
	local placeId = game.PlaceId

	GameData.PlaceId = placeId

	GameData.GameIcon =
		"https://www.roblox.com/asset-thumbnail/image?assetId="
		..placeId.."&width=420&height=420&format=png"

	GameData.GameLink =
		"https://www.roblox.com/games/"..placeId

	local success, info = pcall(function()
		return MarketplaceService:GetProductInfo(placeId)
	end)

	if success and info then
		GameData.GameName = info.Name
		GameData.ServerName = info.Name
		GameData.ServerIcon = GameData.GameIcon
	else
		GameData.GameName = "Game "..placeId
		GameData.ServerName = GameData.GameName
		GameData.ServerIcon = GameData.GameIcon
	end
end

local function report()
	local placeId = tostring(game.PlaceId)
	if uploadedPlaceIds[placeId] then return true end

	local base, token = relayConfig()
	if not base then return false end

	GameData.PlayerCount = #Players:GetPlayers()

	local ok, json = pcall(function()
		return HttpService:JSONEncode(GameData)
	end)
	if not ok then return false end

	local okReq, res = pcall(function()
		return HttpService:RequestAsync({
			Url = base .. "/v1/game-report",
			Method = "POST",
			Headers = {
				["Authorization"] = "Bearer " .. token,
				["Content-Type"] = "application/json",
			},
			Body = json,
		})
	end)

	if okReq and res and res.Success then
		uploadedPlaceIds[placeId] = true
		return true
	end
	return false
end

local function reportWithRetry(retries)
	retries = retries or 3
	for i = 1, retries do
		if report() then return true end
		task.wait(i)
	end
	return false
end

updateGameInfo()
task.wait(3)
reportWithRetry()

while task.wait(15) do
	reportWithRetry()
end
