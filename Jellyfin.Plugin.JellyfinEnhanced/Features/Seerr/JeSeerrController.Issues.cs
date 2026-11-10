using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        [HttpGet("jellyseerr/issue")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssues(
            [FromQuery] int? mediaId,
            [FromQuery] int take = 20,
            [FromQuery] int skip = 0,
            [FromQuery] string? filter = "all",
            [FromQuery] string? sort = "added")
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var queryParts = new List<string>
            {
                $"take={take}",
                $"skip={skip}"
            };

            if (mediaId.HasValue && mediaId.Value > 0)
            {
                queryParts.Add($"mediaId={mediaId.Value}");
            }

            if (!string.IsNullOrWhiteSpace(filter))
            {
                queryParts.Add($"filter={Uri.EscapeDataString(filter)}");
            }

            if (!string.IsNullOrWhiteSpace(sort))
            {
                queryParts.Add($"sort={Uri.EscapeDataString(sort)}");
            }

            var queryString = string.Join("&", queryParts);
            var apiPath = string.IsNullOrWhiteSpace(queryString) ? "/api/v1/issue" : $"/api/v1/issue?{queryString}";

            return ProxyJellyseerrRequest(apiPath, HttpMethod.Get);
        }

        [HttpGet("jellyseerr/issue/{id}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssueById(int id)
        {
            // V8-style guard. Seerr returns 500 for /issue/0 or /issue/-1.
            if (id <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_issue_id",
                    message = "Issue id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/issue/{id}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/issue")]
        [Authorize]
        public async Task<IActionResult> ReportJellyseerrIssue([FromBody] JsonElement issueBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/issue", HttpMethod.Post, issueBody.ToString());
        }
    }
}
