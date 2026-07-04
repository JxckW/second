const axios = require('axios');

// Your API key
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJkYzM3NDRjZC1iODMzLTQyZGUtYTU3MC01MmJkZjhhNjY5ZmMiLCJzdWIiOiJBUElLZXkiLCJpYXQiOjE3ODI0OTMzNTB9.AdQ8_M2uM5ru2mm1AwofW8rwnXq0V2NBqLdPV-soiZI';

const GRAPHQL_URL = 'https://stashdb.org/graphql';

const HEADERS = {
  'Content-Type': 'application/json',
  'ApiKey': API_KEY
};

// GraphQL client
async function gql(query, variables = {}) {
  try {
    const response = await axios.post(GRAPHQL_URL, {
      query,
      variables
    }, {
      headers: HEADERS
    });

    if (response.data.errors) {
      console.error('GraphQL Errors:', response.data.errors);
      throw new Error('GraphQL Error');
    }

    return response.data.data;
  } catch (error) {
    if (error.response) {
      console.error('API Error:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// =========================
// SEARCH PERFORMER - SINGLE RESULT
// =========================

async function findPerformer(name) {
  const query = `
  query SearchPerformer($term: String!) {
    searchPerformer(term: $term) {
      id
      name
      images {
        url
      }
    }
  }`;

  const data = await gql(query, {
    term: name
  });

  return data.searchPerformer?.[0] || null;
}

// =========================
// SEARCH PERFORMERS - ALL RESULTS
// =========================

async function searchPerformers(term) {
  const query = `
  query SearchPerformer($term: String!) {
    searchPerformer(term: $term) {
      id
      name
      images {
        url
      }
      gender
      scene_count
      is_favorite
    }
  }`;

  const data = await gql(query, { term });
  return data.searchPerformer || [];
}

// =========================
// GET PERFORMER DETAILS
// =========================

async function getPerformerDetails(performerId) {
  const query = `
  query PerformerDetails($id: ID!) {
    findPerformer(id: $id) {
      id
      name
      images {
        url
      }
      gender
      age
      height
      scene_count
      aliases
      country
      ethnicity
      is_favorite
    }
  }`;

  const data = await gql(query, { id: performerId });
  return data.findPerformer;
}

// =========================
// GET ALL SCENES WITH PAGINATION
// =========================

async function getScenes(performerID, page = 1, perPage = 24) {
  const query = `
  query PerformerScenes($input: SceneQueryInput!) {
    queryScenes(input: $input) {
      count
      scenes {
        id
        title
        date
        duration
        details
        director
        studio {
          id
          name
        }
        images {
          url
        }
        performers {
          performer {
            id
            name
          }
        }
        tags {
          id
          name
        }
      }
    }
  }`;

  const data = await gql(query, {
    input: {
      performers: {
        value: performerID,
        modifier: "INCLUDES"
      },
      page,
      per_page: perPage
    }
  });

  return {
    count: data.queryScenes.count,
    scenes: data.queryScenes.scenes
  };
}

// =========================
// SEARCH SCENES BY PERFORMER - FETCHES ALL SCENES
// =========================

async function searchPerformerScenes(performerId, searchTerm, page = 1, perPage = 24) {
  // Fetch ALL scenes by paginating through results
  const query = `
  query PerformerScenes($input: SceneQueryInput!) {
    queryScenes(input: $input) {
      count
      scenes {
        id
        title
        date
        duration
        details
        director
        studio {
          id
          name
        }
        images {
          url
        }
        performers {
          performer {
            id
            name
          }
        }
        tags {
          id
          name
        }
      }
    }
  }`;

  let allScenes = [];
  let currentPage = 1;
  const perPageFetch = 100;
  let hasMore = true;

  // Fetch all pages of scenes
  while (hasMore) {
    const data = await gql(query, {
      input: {
        performers: {
          value: performerId,
          modifier: "INCLUDES"
        },
        page: currentPage,
        per_page: perPageFetch
      }
    });

    const scenes = data.queryScenes.scenes || [];
    allScenes = allScenes.concat(scenes);

    // Check if we've fetched all scenes
    const totalCount = data.queryScenes.count || 0;
    hasMore = allScenes.length < totalCount;
    currentPage++;

    // Safety limit - prevent infinite loops (max 1000 scenes)
    if (allScenes.length >= 1000 || currentPage > 20) {
      hasMore = false;
    }
  }

  console.log(`📊 Fetched ${allScenes.length} total scenes for performer`);

  // Filter scenes by title or studio name
  const searchTermLower = searchTerm ? searchTerm.trim().toLowerCase() : '';
  let filteredScenes = allScenes;

  if (searchTermLower) {
    filteredScenes = allScenes.filter(scene => {
      const title = (scene.title || '').toLowerCase();
      const studioName = (scene.studio?.name || '').toLowerCase();
      return title.includes(searchTermLower) || studioName.includes(searchTermLower);
    });
    console.log(`🔍 Found ${filteredScenes.length} scenes matching "${searchTerm}"`);
  }

  // Paginate the filtered results
  const totalCount = filteredScenes.length;
  const startIndex = (page - 1) * perPage;
  const endIndex = Math.min(startIndex + perPage, totalCount);
  const paginatedScenes = filteredScenes.slice(startIndex, endIndex);

  return {
    count: totalCount,
    scenes: paginatedScenes
  };
}

module.exports = {
  findPerformer,
  searchPerformers,
  getPerformerDetails,
  getScenes,
  searchPerformerScenes,
  gql
};