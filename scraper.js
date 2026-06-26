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
// SEARCH PERFORMER
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
// GET PERFORMER DETAILS WITH ALL IMAGES
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

module.exports = {
  findPerformer,
  getScenes,
  getPerformerDetails,
  gql
};